"""Архив закрытых вакансий (vacante.closed): что в него попадает после сбора и что из него уходит."""

import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone

from vacante import closed, collect, direct
from vacante.models import RawPost, Vacancy
from vacante.parse import parse_post
from vacante.store import load_vacancies, save_vacancies

NOW = datetime(2026, 10, 27, 12, tzinfo=timezone.utc)
BARISTA = "Требуется бариста в кофейню «Зерно», 2/2, 12 000 тг за смену, обучение. Звоните 8 701 123 45 67"
COOK = "Требуется повар в столовую, 5/2, 300 000 тг, питание"
JOB = {"id": 7, "city": "astana", "title": "официант", "company": "Кафе «Зерно»", "salary": "250 000 ₸",
       "schedule": "2/2", "address": "ул. Сыганак, 2", "details": "Питание и развозка.", "approved_at": "2026-10-26 10:30:00"}
ONLY_A = "channels:\n  - {username: chan_a, city: almaty}\n"


def card(channel: str, post_id: int, days_ago: float = 1, text: str = BARISTA, city: str = "almaty") -> Vacancy:
    """Карточка из поста канала, опубликованного days_ago дней назад."""
    return parse_post(RawPost("telegram", channel, post_id, f"https://t.me/{channel}/{post_id}", text,
                              NOW - timedelta(days=days_ago), city))


def collect_once(tmp_path, config: str = ONLY_A, now: datetime = NOW, bot: list[dict] | None = None, posts=()) -> dict:
    """Один проход сбора над тем, что лежит в папке данных. Возвращает архив после него."""
    path = tmp_path / "channels.yaml"
    path.write_text(config, "utf-8")

    def fetch(client, name, city, since_id=0, max_age_days=14):
        return [p for p in posts if p.channel == name and p.post_id > since_id]

    collect.run(path, tmp_path / "data", fetch=fetch, now=now,
                direct=None if bot is None else [direct.to_vacancy(job) for job in bot])
    return closed.load(tmp_path / "data")


def on_site(tmp_path) -> set[str]:
    return {v.id for v in load_vacancies(tmp_path / "data")}


def test_expired_vacancy_is_remembered_with_only_what_the_404_page_needs(tmp_path):
    """Срок вышел — вакансия уходит с сайта в архив: название, город, сфера и день. Ни работодателя, ни текста."""
    save_vacancies(tmp_path / "data", [card("chan_a", 1, days_ago=15), card("chan_a", 2, days_ago=3, text=COOK)])
    archive = collect_once(tmp_path)
    assert on_site(tmp_path) == {"chan_a-2"}
    assert archive == {"chan_a-1": {"title": "Бариста", "city": "almaty", "category": "horeca", "closed": "2026-10-27"}}
    text = (tmp_path / "data" / closed.FILE).read_text("utf-8")
    assert "Зерно" not in text and "кофейню" not in text and "701" not in text and "t.me" not in text
    # Следующий проход ничего не меняет: файл тот же до байта
    assert collect_once(tmp_path, now=NOW + timedelta(hours=1)) == archive
    assert (tmp_path / "data" / closed.FILE).read_text("utf-8") == text


def test_vacancy_closed_by_the_employer_is_remembered_and_forgotten_when_it_is_back(tmp_path):
    """Работодатель закрыл свою вакансию в боте: она в архиве. Открыл снова — из архива уходит."""
    assert collect_once(tmp_path, bot=[JOB]) == {} and on_site(tmp_path) == {"bot-7"}
    # Базу бота не прочитали: вакансия остаётся на сайте, закрытой её не считаем
    assert collect_once(tmp_path, bot=None) == {} and on_site(tmp_path) == {"bot-7"}
    assert collect_once(tmp_path, bot=[]) == {
        "bot-7": {"title": "Официант", "city": "astana", "category": "horeca", "closed": "2026-10-27"}}
    assert on_site(tmp_path) == set()
    assert collect_once(tmp_path, bot=[JOB]) == {} and on_site(tmp_path) == {"bot-7"}
    # У вакансии из бота вышел срок: это тоже «закрыта»
    assert set(collect_once(tmp_path, bot=[JOB], now=NOW + timedelta(days=20))) == {"bot-7"}


def test_hh_vacancy_keeps_its_kazakh_title(tmp_path):
    seller = replace(card("chan_a", 1, days_ago=20), id="hh-55", source="hh", title="Продавец", title_kk="Сатушы",
                     category="retail", city=None)
    save_vacancies(tmp_path / "data", [seller])
    assert collect_once(tmp_path) == {
        "hh-55": {"title": "Продавец", "title_kk": "Сатушы", "city": None, "category": "retail", "closed": "2026-10-27"}}


def test_what_was_taken_off_the_site_is_never_remembered(tmp_path, monkeypatch):
    """В архив идёт только то, что ушло само. Пост перестал считаться вакансией, канал отключён или убран
    из сбора, источник неизвестен — такого в архиве нет, даже если у вакансии заодно вышел срок."""
    saved = [card("chan_a", 1, days_ago=15), card("chan_a", 66, days_ago=15, text=COOK), card("chan_a", 67, text=COOK),
             card("chan_off", 2, days_ago=15), card("chan_off", 3),
             card("chan_gone", 4, days_ago=15), card("chan_gone", 5),
             replace(card("chan_a", 8, days_ago=15), id="xx-8", source="xx")]
    save_vacancies(tmp_path / "data", saved)
    explain = collect.explain
    # Новые правила разбора больше не считают посты 66 и 67 вакансиями
    monkeypatch.setattr(collect, "explain", lambda post: (None, "white_collar") if post.post_id in (66, 67) else explain(post))
    config = ONLY_A + "  - {username: chan_off, city: almaty, enabled: false}\n"  # chan_gone из списка убран совсем
    archive = collect_once(tmp_path, config)
    assert set(archive) == {"chan_a-1"}
    # Карточка убранного из списка канала остаётся на сайте до конца срока (так было и раньше), но в архив не идёт
    assert on_site(tmp_path) == {"chan_gone-5"}
    assert set(collect_once(tmp_path, config, now=NOW + timedelta(days=14))) == {"chan_a-1"} and on_site(tmp_path) == set()


def test_repost_glued_to_a_saved_card_changes_nothing_in_the_archive(tmp_path):
    """Повтор вакансии из другого канала склеивается с карточкой на сайте: никто никуда не ушёл."""
    save_vacancies(tmp_path / "data", [card("chan_a", 1)])
    repost = RawPost("telegram", "chan_b", 9, "https://t.me/chan_b/9", BARISTA, NOW - timedelta(hours=1), "almaty")
    assert collect_once(tmp_path, ONLY_A + "  - {username: chan_b, city: almaty}\n", posts=[repost]) == {}
    [saved] = load_vacancies(tmp_path / "data")
    assert (saved.id, saved.also_seen_in) == ("chan_a-1", ["https://t.me/chan_b/9"])


def test_takedown_also_removes_what_was_remembered_before(tmp_path):
    """Канал отключили или убрали из сбора по просьбе владельца: прежние записи о его постах из архива уходят."""
    both = ONLY_A + "  - {username: Chan_B, city: almaty}\n"
    save_vacancies(tmp_path / "data", [card("chan_a", 1, days_ago=15), card("chan_b", 2, days_ago=15),
                                       replace(card("chan_a", 3, days_ago=15), id="olx-3", source="olx")])
    assert set(collect_once(tmp_path, both)) == {"chan_a-1", "chan_b-2", "olx-3"}  # имя канала в списке с большой буквы
    assert set(collect_once(tmp_path, ONLY_A + "  - {username: chan_b, city: almaty, enabled: false}\n")) == {"chan_a-1", "olx-3"}
    closed.save(tmp_path / "data", {**closed.load(tmp_path / "data"),
                                    "chan_b-2": closed.entry(card("chan_b", 2), "2026-10-27")})
    assert set(collect_once(tmp_path, ONLY_A)) == {"chan_a-1", "olx-3"}


def test_archive_forgets_after_sixty_days_and_what_is_live_again(tmp_path):
    data = tmp_path / "data"
    old, edge, fresh = (closed.entry(card("chan_a", 1), day) for day in ("2026-08-27", "2026-08-28", "2026-10-20"))
    closed.save(data, {"chan_a-1": old, "chan_a-2": edge, "chan_a-3": fresh, "chan_a-4": fresh})
    back = card("chan_a", 4)
    assert closed.update(data, [], [back], {"chan_a"}, NOW) == 2
    assert set(closed.load(data)) == {"chan_a-2", "chan_a-3"}  # ровно 60 дней ещё помним
    # Ушла и в тот же проход снова на сайте (такого не бывает, но если что — на сайте важнее)
    assert closed.update(data, [back], [back], {"chan_a"}, NOW) == 2 and "chan_a-4" not in closed.load(data)


def test_archive_file_is_sorted_one_vacancy_per_line(tmp_path):
    """Файл пишется одинаково при любом порядке записей и полей: в ветке data меняются только строки изменений."""
    data = tmp_path / "data"
    first = {"title": "Повар", "city": "astana", "category": "horeca", "closed": "2026-10-27"}
    second = {"closed": "2026-10-26", "category": "retail", "title_kk": "Сатушы", "city": None, "title": "Продавец"}
    closed.save(data, {"hh-9": second, "chan_a-10": first})
    text = (data / closed.FILE).read_text("utf-8")
    assert text == ('{\n"chan_a-10": {"category": "horeca", "city": "astana", "closed": "2026-10-27", "title": "Повар"},\n'
                    '"hh-9": {"category": "retail", "city": null, "closed": "2026-10-26", "title": "Продавец", '
                    '"title_kk": "Сатушы"}\n}\n')
    closed.save(data, {"chan_a-10": dict(reversed(first.items())), "hh-9": second})
    assert (data / closed.FILE).read_text("utf-8") == text and closed.load(data) == {"chan_a-10": first, "hh-9": second}
    closed.save(data, {})
    assert (data / closed.FILE).read_text("utf-8") == "{}\n" and closed.load(data) == {}


def test_broken_or_missing_archive_reads_as_empty_and_collection_goes_on(tmp_path):
    """Файла нет, в нём мусор или чужие поля: архив читается пустым или без негодных записей, сбор не падает."""
    data = tmp_path / "data"
    assert closed.load(data) == {}
    data.mkdir()
    for junk in ("", "{", "[1, 2]", '"строка"', "null", "<<<<<<< HEAD\n{}\n=======\n", "[" * 100_000):
        (data / closed.FILE).write_text(junk, "utf-8")
        assert closed.load(data) == {}
    (data / closed.FILE).write_bytes(b"\xff\xfe\x00")
    assert closed.load(data) == {}
    good = {"title": "Повар", "city": "astana", "category": "horeca", "closed": "2026-10-27"}
    (data / closed.FILE).write_text(json.dumps({
        "chan_a-1": {**good, "employer": "Зерно", "text": "лишнее"}, "chan_a-2": "не запись", "chan_a-3": {**good, "title": " "},
        "chan_a-4": {**good, "closed": "вчера"}, "chan_a-5": {**good, "closed": 5}, "chan a/6": good, "chan_a-7": {**good, "city": 7},
        "chan_a-8": {"title": "Повар"}, "chan_a-9": {**good, "title_kk": ""}}, ensure_ascii=False), "utf-8")
    assert closed.load(data) == {"chan_a-1": good, "chan_a-7": {**good, "city": None}, "chan_a-9": good}
    # Сбор поверх испорченного файла: проходит и записывает архив заново
    (data / closed.FILE).write_text("{ мусор", "utf-8")
    save_vacancies(data, [card("chan_a", 1, days_ago=15)])
    assert set(collect_once(tmp_path)) == {"chan_a-1"}


def test_shard_number_is_stable():
    """Часть архива для id: числа записаны здесь, чтобы формула не поменялась незаметно (её повторяет страница 404)."""
    assert [closed.shard(i) for i in ("hh-1", "bot-7", "olx-398112345", "almaty_rabota01-12345", "")] == [78, 33, 188, 451, 0]
    assert all(0 <= closed.shard(f"chan_{i}-{i * 7919}") < closed.SHARDS for i in range(2000))

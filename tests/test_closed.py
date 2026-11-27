"""Архив закрытых вакансий (vacante.closed): что в него попадает после сбора и что из него уходит."""

import json
import shutil
import subprocess
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest

from vacante import closed, collect, direct
from vacante.models import RawPost, Vacancy
from vacante.parse import parse_post
from vacante.site.build import build
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


# Страница 404 и части архива на сайте

# Запускает скрипт страницы 404 в node: вместо браузера — заготовки document, location и fetch (части архива
# читаются из собранного сайта). Печатает, что стало со страницей для каждого адреса
HARNESS = r"""
const fs = require('fs'), path = require('path');
const [out, root, cases] = [process.argv[2], process.argv[3], JSON.parse(process.argv[4])];
const html = fs.readFileSync(path.join(out, '404.html'), 'utf8');
const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("'/closed/'"));
const el = () => ({ textContent: '', hidden: false, children: [], appendChild(child) { this.children.push(child); } });
const run = ({ pathname, mode }) => new Promise((done) => {
  const els = { 'gone-title': el(), 'gone-links': el(), 'gone-text': el() };
  els['gone-title'].textContent = 'Вакансия уже закрыта';
  els['gone-links'].hidden = true;
  const document = { title: '404', documentElement: { lang: 'ru' }, getElementById: (id) => els[id], createElement: el };
  const fetched = [];
  const fetch = (url) => {
    fetched.push(url);
    if (mode === 'offline') return Promise.reject(new Error('нет сети'));
    const file = path.join(out, url.slice(root.length));
    if (!url.startsWith(root + '/') || !fs.existsSync(file)) return Promise.resolve({ ok: false, json: () => Promise.reject(new Error('это не JSON')) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8'))) });
  };
  new Function('location', 'document', 'window', 'fetch', code)({ pathname }, document, mode === 'old' ? {} : { fetch }, fetch);
  setTimeout(() => done({ title: els['gone-title'].textContent, links: els['gone-links'].children.map((a) => [a.textContent, a.href]),
                          shown: !els['gone-links'].hidden, generic: !els['gone-text'].hidden, tab: document.title,
                          lang: document.documentElement.lang, fetched }), 5);
});
(async () => {
  const results = [];
  for (const one of cases) results.push(await run(one));
  console.log(JSON.stringify(results));
})();
"""


def open_404(tmp_path, out, *addresses: str, root: str = "", mode: str = "") -> list[dict]:
    """Что покажет страница 404 по каждому адресу: заголовок, ссылки, остался ли общий текст."""
    node = shutil.which("node")
    if not node:
        pytest.skip("нет node: скрипт страницы 404 запустить нечем")
    (tmp_path / "open404.js").write_text(HARNESS, "utf-8")
    cases = json.dumps([{"pathname": address, "mode": mode} for address in addresses])
    done = subprocess.run([node, str(tmp_path / "open404.js"), str(out), root, cases], capture_output=True, text=True,
                          timeout=60, check=False)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


GENERIC = {"title": "Вакансия уже закрыта", "links": [], "shown": False, "generic": True, "tab": "404", "lang": "ru"}


def site_with_archive(tmp_path, base_url: str = "https://vacante.kz", extra: dict | None = None):
    """Сайт с тремя официантами и поваром в Алматы и продавцом в Астане; в архиве закрытые вакансии на все случаи."""
    live = [card("chan_a", 100 + i, text=f"Кафе «Зерно {i}» ищет официанта, 2/2, {200 + i} 000 тг") for i in range(3)]
    live += [card("chan_a", 110, text=COOK), card("chan_a", 111, text="Нужен продавец в магазин, 200 000 тг", city="astana")]
    data = tmp_path / "data"
    save_vacancies(data, live)
    entry = lambda title, city, category, **more: {"title": title, "city": city, "category": category,  # noqa: E731
                                                   "closed": "2026-10-20", **more}
    closed.save(data, {
        "chan_a-1": entry("Официант", "almaty", "horeca"),  # есть страница профессии
        "chan_a-2": entry("Повар", "almaty", "horeca"),  # поваров мало для своей страницы: страница сферы
        "chan_a-3": entry("Грузчик", "almaty", "warehouse"),  # ни профессии, ни сферы: страница города
        "chan_a-4": entry("Курьер", "taraz", "delivery"),  # в городе сейчас нет вакансий
        "hh-5": entry("Продавец в магазин у дома", None, "retail", title_kk="Үй жанындағы дүкенге сатушы"),
        "chan_a-6": entry("Повар, Официант", "almaty", "horeca"),
        "chan_a-7": entry("Официант", "atlantis", "horeca"),  # города больше нет в списке городов
        "chan_a-8": entry("Сотрудник", "almaty", "space"),  # и сферы такой нет
        "chan_a-100": entry("Официант", "almaty", "horeca"),  # снова на сайте: в частях архива её нет
        **(extra or {})})
    out = tmp_path / "public"
    build(data, out, base_url, now=NOW)
    return out


def test_site_gets_the_archive_in_small_parts_with_the_best_list_page(tmp_path):
    """Сборка кладёт архив частями closed/<n>.json: название, казахское название, город и лучшая страница списка
    из тех, что есть в этой сборке."""
    out = site_with_archive(tmp_path)
    rows = {}
    for part in (out / "closed").iterdir():
        found = json.loads(part.read_text("utf-8"))
        assert all(part.name == f"{closed.shard(key)}.json" for key in found)
        rows.update(found)
    assert rows == {
        "chan_a-1": ["Официант", "Даяшы", "almaty", "almaty/oficiant"],
        "chan_a-2": ["Повар", "Аспаз", "almaty", "almaty/horeca"],
        "chan_a-3": ["Грузчик", "Жүк тиеуші", "almaty", "almaty"],
        "chan_a-4": ["Курьер", "", "taraz", ""],
        "hh-5": ["Продавец в магазин у дома", "Үй жанындағы дүкенге сатушы", "", ""],
        "chan_a-6": ["Повар, Официант", "Аспаз, Даяшы", "almaty", "almaty/oficiant"],
        "chan_a-7": ["Официант", "Даяшы", "", ""],
        "chan_a-8": ["Сотрудник", "Қызметкер", "almaty", "almaty"],
    }
    # Адреса карты сайта прежние: части архива в неё не попадают
    assert "closed" not in (out / "sitemap.xml").read_text("utf-8")


def test_site_builds_without_the_archive_or_with_a_broken_one(tmp_path):
    for number, junk in enumerate((None, "{ мусор", "[]", '{"chan_a-1": {"title": 5}}')):
        data = tmp_path / str(number) / "data"
        save_vacancies(data, [card("chan_a", 1, text=COOK)])
        if junk is not None:
            (data / closed.FILE).write_text(junk, "utf-8")
        out = tmp_path / str(number) / "public"
        build(data, out, now=NOW)
        assert not (out / "closed").exists() and "Вакансия уже закрыта" in (out / "404.html").read_text("utf-8")


def test_404_page_names_the_closed_vacancy_and_links_to_similar_ones(tmp_path):
    """По адресу закрытой вакансии страница 404 называет её и город и ведёт на похожие; под /kk/ — по-казахски."""
    out = site_with_archive(tmp_path)
    page = (out / "404.html").read_text("utf-8")
    assert "<h1 id=\"gone-title\">Вакансия уже закрыта</h1>" in page and "http-equiv" not in page
    assert len(page.encode()) < 10_000  # страница остаётся маленькой
    ru, kk, no_slash, city_only, no_page, no_city, two = open_404(
        tmp_path, out, "/v/chan_a-1/", "/kk/v/chan_a-1/", "/v/chan_a-2", "/v/chan_a-3/", "/v/chan_a-4/", "/kk/v/hh-5/",
        "/v/chan_a-6/")
    assert ru == {"title": "Вакансия «Официант» в Алматы закрыта", "shown": True, "generic": False, "lang": "ru",
                  "links": [["Похожие вакансии в Алматы", "/almaty/oficiant/"], ["Работа в Алматы", "/almaty/"]],
                  "tab": "Вакансия «Официант» в Алматы закрыта | vacante.kz",
                  "fetched": [f"/closed/{closed.shard('chan_a-1')}.json"]}
    assert kk == {"title": "Алматыдағы «Даяшы» вакансиясы жабылған", "shown": True, "generic": False, "lang": "kk",
                  "links": [["Алматыдағы ұқсас вакансиялар", "/kk/almaty/oficiant/"], ["Алматыдағы жұмыс", "/kk/almaty/"]],
                  "tab": "Алматыдағы «Даяшы» вакансиясы жабылған | vacante.kz",
                  "fetched": [f"/closed/{closed.shard('chan_a-1')}.json"]}
    assert no_slash["links"] == [["Похожие вакансии в Алматы", "/almaty/horeca/"], ["Работа в Алматы", "/almaty/"]]
    assert (city_only["title"], city_only["links"]) == ("Вакансия «Грузчик» в Алматы закрыта", [["Работа в Алматы", "/almaty/"]])
    # Страницы города в этой сборке нет: город называем, а ссылка ведёт на главную
    assert (no_page["title"], no_page["links"]) == ("Вакансия «Курьер» в Таразе закрыта", [["Работа в Казахстане", "/"]])
    assert (no_city["title"], no_city["links"]) == ("«Үй жанындағы дүкенге сатушы» вакансиясы жабылған",
                                                    [["Қазақстандағы жұмыс", "/kk/"]])
    assert two["title"] == "Вакансия «Повар, Официант» в Алматы закрыта"


def test_404_page_keeps_the_generic_text_when_it_knows_nothing(tmp_path):
    """Вакансии в архиве нет, адрес не вакансии, сеть подвела, браузер без fetch: остаётся прежний общий текст."""
    out = site_with_archive(tmp_path)
    unknown, live_again, other, deep, wrong_id = open_404(tmp_path, out, "/v/chan_a-999/", "/v/chan_a-100/", "/almaty/nothing/",
                                                          "/v/chan_a-1/extra/", "/v/chan a-1/")
    assert unknown == {**GENERIC, "fetched": [f"/closed/{closed.shard('chan_a-999')}.json"]}
    assert live_again == {**GENERIC, "fetched": [f"/closed/{closed.shard('chan_a-100')}.json"]}
    assert other == deep == wrong_id == {**GENERIC, "fetched": []}  # не адрес вакансии: архив и не спрашиваем
    [offline] = open_404(tmp_path, out, "/v/chan_a-1/", mode="offline")
    assert offline == {**GENERIC, "fetched": [f"/closed/{closed.shard('chan_a-1')}.json"]}
    [old] = open_404(tmp_path, out, "/v/chan_a-1/", mode="old")
    assert old == {**GENERIC, "fetched": []}


def test_404_page_trusts_nothing_from_the_archive_file(tmp_path):
    """Значения из части архива идут на страницу только текстом, а в ссылку — только путь списка в городе вакансии."""
    out = site_with_archive(tmp_path)
    bad = {"evil-1": ["<img src=x onerror=alert(1)>", "", "almaty", "//evil.example/x"],
           "evil-2": ["Повар", "", "almaty", "astana/povar"], "evil-3": "строка", "evil-4": ["Повар", "", "nowhere", "nowhere/povar"],
           "evil-5": ["Повар", "", "almaty", "almaty/povar?x=1"], "evil-6": ["Повар", "", "almaty", "javascript:alert(1)"],
           "evil-7": [5, "", "almaty", "almaty"], "evil-8": ["Повар", 5, 5, 5], "evil-9": ["{where} $& Повар", "", "almaty", "almaty"]}
    for key, row in bad.items():
        part = out / "closed" / f"{closed.shard(key)}.json"
        part.parent.mkdir(exist_ok=True)
        part.write_text(json.dumps({**(json.loads(part.read_text("utf-8")) if part.exists() else {}), key: row}), "utf-8")
    home = [["Работа в Казахстане", "/"]]
    html, other_city, not_a_row, no_such_city, query, script, number, numbers, braces, proto = open_404(
        tmp_path, out, *(f"/v/{key}/" for key in bad), "/v/constructor/")
    assert (html["title"], html["links"]) == ("Вакансия «<img src=x onerror=alert(1)>» в Алматы закрыта", home)
    assert other_city["links"] == query["links"] == script["links"] == home
    assert (no_such_city["title"], no_such_city["links"]) == ("Вакансия «Повар» закрыта", home)
    assert (numbers["title"], numbers["links"]) == ("Вакансия «Повар» закрыта", home)
    assert braces["title"] == "Вакансия «{where} $& Повар» в Алматы закрыта"
    for untouched in (not_a_row, number, proto):
        assert untouched["title"] == GENERIC["title"] and untouched["generic"] and not untouched["shown"]


def test_404_page_works_under_a_base_path_and_finds_every_id_in_its_part(tmp_path):
    """Сайт на <user>.github.io/vacante: адреса с /vacante. И браузер считает номер части так же, как сборка."""
    ids = ["bot-7", "olx-398112345", "hh-123456789", "almaty_rabota01-12345", "A-Z_09-1", "-", "_", "x" * 80,
           *(f"chan_{i}-{i * 7919}" for i in range(40))]
    extra = {key: {"title": f"Повар {number}", "city": "almaty", "category": "horeca", "closed": "2026-10-20"}
             for number, key in enumerate(ids)}
    out = site_with_archive(tmp_path, "https://example.github.io/vacante", extra)
    results = open_404(tmp_path, out, *(f"/vacante/v/{key}/" for key in ids), root="/vacante")
    assert [r["title"] for r in results] == [f"Вакансия «Повар {number}» в Алматы закрыта" for number in range(len(ids))]
    assert results[0]["links"] == [["Похожие вакансии в Алматы", "/vacante/almaty/horeca/"], ["Работа в Алматы", "/vacante/almaty/"]]
    assert results[0]["fetched"] == [f"/vacante/closed/{closed.shard('bot-7')}.json"]
    [kk, outside] = open_404(tmp_path, out, "/vacante/kk/v/bot-7/", "/v/bot-7/", root="/vacante")
    assert kk["links"][1] == ["Алматыдағы жұмыс", "/vacante/kk/almaty/"]
    assert outside == {**GENERIC, "fetched": []}  # адрес не под /vacante: это не наш сайт


def test_expired_vacancy_goes_all_the_way_from_collection_to_the_404_page(tmp_path):
    """Вся цепочка: у вакансии вышел срок — сбор записал её в архив — сборка положила в часть — страница 404 её назвала."""
    save_vacancies(tmp_path / "data", [card("chan_a", 1, days_ago=15), card("chan_a", 2, text=COOK)])
    collect_once(tmp_path)
    out = tmp_path / "public"
    build(tmp_path / "data", out, now=NOW)
    assert not (out / "v" / "chan_a-1").exists() and (out / "v" / "chan_a-2" / "index.html").exists()
    [gone] = open_404(tmp_path, out, "/v/chan_a-1/")
    assert (gone["title"], gone["links"]) == ("Вакансия «Бариста» в Алматы закрыта",
                                              [["Похожие вакансии в Алматы", "/almaty/horeca/"], ["Работа в Алматы", "/almaty/"]])

import json
from datetime import datetime, timezone

from vacante import autopost, collect, direct
from vacante.models import RawPost
from vacante.site.admin import unseal
from vacante.site.build import build

NOW = datetime(2026, 10, 27, 12, tzinfo=timezone.utc)
JOB = {"id": 7, "city": "almaty", "title": "официант", "company": "Кафе «Зерно»", "salary": "12 000 ₸ за смену",
       "schedule": "2/2 с 10:00 до 22:00", "address": "ул. Сыганак, 2",
       "details": "Питание и развозка. Обучаем с нуля.\nЗвоните +7 701 123 45 67", "approved_at": "2026-10-27 10:30:00"}
TG_TEXT = "Требуется бариста в кофейню «Зерно», 2/2, 12 000 тг за смену, обучение"


def test_job_from_bot_becomes_vacancy():
    v = direct.to_vacancy(JOB)
    assert (v.id, v.source, v.source_url) == ("bot-7", "bot", "https://t.me/vacantekz_bot?start=apply_7")
    assert (v.title, v.category, v.employer, v.city, v.address) == ("Официант", "horeca", "Кафе «Зерно»", "almaty", "ул. Сыганак, 2")
    assert (v.salary_min, v.salary_max, v.salary_period) == (12000, None, "day")
    assert v.schedule == "2/2 с 10:00 до 22:00" and "Питание" in v.perks
    assert v.posted_at == "2026-10-27T10:30:00+00:00"
    assert "701" not in v.text and v.text.startswith("Питание и развозка")


def test_unparsed_salary_and_empty_details_still_shown():
    v = direct.to_vacancy({**JOB, "title": "Помощник", "salary": "договорная", "schedule": None, "address": None,
                           "details": None})
    assert (v.salary_min, v.salary_max, v.category, v.schedule) == (None, None, "other", None)
    assert v.text == "Помощник, Кафе «Зерно».\n\nЗарплата: договорная"


def run_collect(tmp_path, posts, direct_jobs):
    config = tmp_path / "channels.yaml"
    config.write_text("channels:\n  - username: chan_a\n    city: almaty\n", "utf-8")

    def fetch(client, name, city, since_id=0, max_age_days=14):
        return [p for p in posts if p.post_id > since_id]

    vacancies = None if direct_jobs is None else [direct.to_vacancy(j) for j in direct_jobs]
    collect.run(config, tmp_path / "data", fetch=fetch, now=NOW, direct=vacancies)
    return json.loads((tmp_path / "data" / "vacancies.json").read_text("utf-8"))


def test_collect_keeps_bot_jobs_in_sync_with_database(tmp_path):
    post = RawPost("telegram", "chan_a", 1, "https://t.me/chan_a/1", TG_TEXT, datetime(2026, 10, 27, 9, tzinfo=timezone.utc), "almaty")
    saved = run_collect(tmp_path, [post], [JOB])
    assert sorted(v["id"] for v in saved) == ["bot-7", "chan_a-1"]
    # База бота недоступна: вакансия работодателя остаётся как была, разбор каналов её не трогает
    saved = run_collect(tmp_path, [post], None)
    assert sorted(v["id"] for v in saved) == ["bot-7", "chan_a-1"]
    # Работодатель закрыл вакансию: с сайта уходит
    saved = run_collect(tmp_path, [post], [])
    assert [v["id"] for v in saved] == ["chan_a-1"]


def test_channel_repost_of_bot_job_is_glued_to_it(tmp_path):
    job = {**JOB, "title": "Бариста", "details": TG_TEXT, "schedule": "2/2", "salary": "12 000 тг за смену", "address": None}
    run_collect(tmp_path, [], [job])
    repost = RawPost("telegram", "chan_a", 5, "https://t.me/chan_a/5", TG_TEXT, datetime(2026, 10, 27, 11, tzinfo=timezone.utc), "almaty")
    saved = run_collect(tmp_path, [repost], [job])
    assert [(v["id"], v["also_seen_in"]) for v in saved] == [("bot-7", ["https://t.me/chan_a/5"])]
    saved = run_collect(tmp_path, [repost], [job])  # склейка переживает следующий сбор
    assert saved[0]["also_seen_in"] == ["https://t.me/chan_a/5"]


def test_site_shows_bot_job_with_apply_button(tmp_path):
    run_collect(tmp_path, [], [JOB])
    build(tmp_path / "data", tmp_path / "out", now=NOW, admin_password="пароль")
    page = (tmp_path / "out" / "v" / "bot-7" / "index.html").read_text("utf-8")
    assert 'href="https://t.me/vacantekz_bot?start=apply_7"' in page and "Откликнуться в Telegram" in page
    assert "Источник:" not in page and "оригинальном объявлении</a>" not in page
    listing = (tmp_path / "out" / "almaty" / "index.html").read_text("utf-8")
    assert "От работодателя" in listing and 'href="https://t.me/vacantekz_bot?start=post"' in listing
    admin = unseal(json.loads((tmp_path / "out" / "admin" / "sealed.json").read_text("utf-8")), "пароль")
    assert admin["totals"]["direct"] == 1


def test_autopost_puts_bot_job_first_with_apply_button(tmp_path):
    post = RawPost("telegram", "chan_a", 1, "https://t.me/chan_a/1", TG_TEXT + "\nКофейня «Зерно», питание",
                   datetime(2026, 10, 27, 11, tzinfo=timezone.utc), "almaty")
    vacancies = [collect.explain(post)[0], direct.to_vacancy({**JOB, "details": None, "schedule": None})]
    v = autopost.pick(vacancies, "almaty", {}, NOW)
    assert v.id == "bot-7"
    assert ("✉️ Откликнуться", "https://t.me/vacantekz_bot?start=apply_7") in autopost.make_post(v, "https://vacante.kz").buttons


def test_agent_salary_numbers_win_over_text():
    v = direct.to_vacancy({**JOB, "salary": "250 000 ₸ в месяц + бонусы", "salary_min": 250000, "salary_max": None,
                           "salary_period": "month"})
    assert (v.salary_min, v.salary_max, v.salary_period) == (250000, None, "month") and "Бонусы" in v.perks


def test_queue_item_has_no_contacts():
    item = direct.queue_item({**JOB, "status": "pending", "reviewed_at": None, "created_at": "2026-10-27 12:00:00",
                              "employer_name": "Дана (@dana)", "details": "Звоните +7 701 123 45 67, t.me/dana_cafe"})
    assert item["city_name"] == "Алматы" and item["status"] == "pending"
    assert "employer_name" not in item and "701" not in item["details"] and "t.me" not in item["details"]


def test_bot_job_goes_to_channel_at_once_but_not_at_night(tmp_path):
    from vacante.store import save_vacancies
    job = direct.to_vacancy({**JOB, "approved_at": "2026-10-27 06:50:00"})
    save_vacancies(tmp_path, [job])
    autopost.save_posted(tmp_path, {"almaty": {"ids": [], "titles": [], "last_at": "2026-10-27T06:55:00+00:00"}})
    sent = []
    send = lambda chat, post: sent.append((chat, [b[0] for b in post.buttons]))  # noqa: E731
    night = datetime(2026, 10, 27, 2, 30, tzinfo=timezone.utc)  # 7:30 по Казахстану
    assert autopost.run(tmp_path, "https://vacante.kz", send, now=night) == {"posted": 0, "failed": 0}
    # В 12:00 общий слот ещё не подошёл (последний пост в 11:55), а вакансия работодателя выходит сразу
    stats = autopost.run(tmp_path, "https://vacante.kz", send, now=datetime(2026, 10, 27, 7, tzinfo=timezone.utc))
    assert stats == {"posted": 1, "failed": 0, "direct": 1}
    assert sent == [("@vacantealmaty", ["👆 Подробнее", "✉️ Откликнуться", "📍 Открыть в 2ГИС"])]
    state = autopost.load_posted(tmp_path)["almaty"]
    assert state["ids"] == ["bot-7"] and state["last_at"] == "2026-10-27T06:55:00+00:00"
    # Второй раз не публикуется
    assert autopost.run(tmp_path, "https://vacante.kz", send, now=datetime(2026, 10, 27, 8, tzinfo=timezone.utc))["posted"] == 0


def test_bot_job_waits_for_agent_before_channel(tmp_path):
    from vacante.store import save_vacancies
    save_vacancies(tmp_path, [direct.to_vacancy({**JOB, "approved_at": "2026-10-27 06:50:00"})])
    autopost.save_posted(tmp_path, {"almaty": {"ids": [], "titles": [], "last_at": "2026-10-27T06:00:00+00:00"}})
    queue = tmp_path / "moderation.json"
    sent = []
    send = lambda chat, post: sent.append(chat)  # noqa: E731
    # Модератор опубликовал №7 кнопкой, агент ещё не оформил: ни сразу, ни в общий слот
    queue.write_text(json.dumps({"jobs": [{"id": 7, "status": "approved", "reviewed_at": None}]}), "utf-8")
    assert autopost.run(tmp_path, "https://vacante.kz", send, now=datetime(2026, 10, 27, 9, tzinfo=timezone.utc))["posted"] == 0
    # Агент оформил: очередь пуста, вакансия выходит
    queue.write_text(json.dumps({"jobs": []}), "utf-8")
    assert autopost.run(tmp_path, "https://vacante.kz", send, now=datetime(2026, 10, 27, 9, 5, tzinfo=timezone.utc))["direct"] == 1
    assert sent == ["@vacantealmaty"]


def test_paid_top_goes_first_on_site_and_stays_past_max_age(tmp_path):
    old = {**JOB, "id": 8, "title": "повар", "approved_at": "2026-10-01 10:00:00", "boost_until": "2026-11-03 10:00:00"}
    run_collect(tmp_path, [], [JOB, old])
    build(tmp_path / "data", tmp_path / "out", now=NOW)
    listing = (tmp_path / "out" / "almaty" / "index.html").read_text("utf-8")
    assert listing.index("/v/bot-8/") < listing.index("/v/bot-7/")  # старше, но оплачена
    assert listing.count("🔥 Срочно") == 1 and 'class="card top"' in listing
    # Когда «Срочно» кончилось, вакансия снова обычная
    build(tmp_path / "data", tmp_path / "out", now=datetime(2026, 11, 4, tzinfo=timezone.utc))
    assert "🔥 Срочно" not in (tmp_path / "out" / "almaty" / "index.html").read_text("utf-8")


def test_paid_top_is_posted_again_once_per_payment(tmp_path):
    from vacante.store import save_vacancies
    job = {**JOB, "approved_at": "2026-10-20 06:50:00"}
    save_vacancies(tmp_path, [direct.to_vacancy(job)])
    autopost.save_posted(tmp_path, {"almaty": {"ids": ["bot-7"], "titles": [], "last_at": "2026-10-27T06:55:00+00:00"}})
    sent, pins = [], []

    def send(chat, post):
        sent.append(post.caption)
        return 500 + len(sent)  # message_id поста в канале

    def pin(chat, message_id, on):
        pins.append((chat, message_id, on))

    at = lambda h, day=27: datetime(2026, 10, day, h, tzinfo=timezone.utc)  # noqa: E731
    assert autopost.run(tmp_path, "https://vacante.kz", send, now=at(7), pin=pin)["posted"] == 0  # уже выходила
    save_vacancies(tmp_path, [direct.to_vacancy({**job, "boost_until": "2026-10-29 07:30:00"})])
    stats = autopost.run(tmp_path, "https://vacante.kz", send, now=at(8), pin=pin)
    assert stats["direct"] == 1 and stats["pinned"] == 1
    assert sent[0].startswith("🔥 <b>Срочно!</b>\nВ Кафе «Зерно» требуется")
    assert pins == [("@vacantealmaty", 501, True)]  # закреплён на весь оплаченный срок
    assert autopost.run(tmp_path, "https://vacante.kz", send, now=at(9), pin=pin)["posted"] == 0
    assert len(pins) == 1
    # Продление: новый срок, ещё один пост и закреп; старый закреп снимается, когда кончится его срок
    save_vacancies(tmp_path, [direct.to_vacancy({**job, "boost_until": "2026-11-05 07:30:00"})])
    assert autopost.run(tmp_path, "https://vacante.kz", send, now=at(10), pin=pin)["direct"] == 1
    assert pins[-1] == ("@vacantealmaty", 502, True)
    assert autopost.run(tmp_path, "https://vacante.kz", send, now=at(8, 29), pin=pin)["unpinned"] == 1
    assert pins[-1] == ("@vacantealmaty", 501, False)
    # Работодатель закрыл вакансию раньше: открепляем сразу
    save_vacancies(tmp_path, [])
    assert autopost.run(tmp_path, "https://vacante.kz", send, now=at(9, 29), pin=pin)["unpinned"] == 1
    assert pins[-1] == ("@vacantealmaty", 502, False)
    assert autopost.load_posted(tmp_path)["almaty"]["pins"] == []

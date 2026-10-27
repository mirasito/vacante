import json
from datetime import datetime, timezone

from vacante import autopost, collect, direct
from vacante.models import RawPost
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
    build(tmp_path / "data", tmp_path / "out", now=NOW)
    page = (tmp_path / "out" / "v" / "bot-7" / "index.html").read_text("utf-8")
    assert 'href="https://t.me/vacantekz_bot?start=apply_7"' in page and "Откликнуться в Telegram" in page
    assert "Источник:" not in page and "оригинальном объявлении</a>" not in page
    listing = (tmp_path / "out" / "almaty" / "index.html").read_text("utf-8")
    assert "От работодателя" in listing and 'href="https://t.me/vacantekz_bot?start=post"' in listing
    admin = json.loads((tmp_path / "out" / "admin" / "data.json").read_text("utf-8"))
    assert admin["totals"]["direct"] == 1


def test_autopost_puts_bot_job_first_with_apply_button(tmp_path):
    post = RawPost("telegram", "chan_a", 1, "https://t.me/chan_a/1", TG_TEXT + "\nКофейня «Зерно», питание",
                   datetime(2026, 10, 27, 11, tzinfo=timezone.utc), "almaty")
    vacancies = [collect.explain(post)[0], direct.to_vacancy({**JOB, "details": None, "schedule": None})]
    v = autopost.pick(vacancies, "almaty", {}, NOW)
    assert v.id == "bot-7"
    assert ("✉️ Откликнуться", "https://t.me/vacantekz_bot?start=apply_7") in autopost.make_post(v, "https://vacante.kz").buttons

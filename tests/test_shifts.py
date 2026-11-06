from datetime import datetime, timezone

from tests.test_hh import item
from vacante import digest, shifts
from vacante.digest import Subscription
from vacante.models import RawPost
from vacante.parse import parse_post, parse_schedule
from vacante.sources import hh


def post(text: str):
    raw = RawPost("telegram", "chan", 1, "https://t.me/chan/1", text, datetime(2026, 11, 6, tzinfo=timezone.utc),
                  "almaty")
    return parse_post(raw)


def test_kind_by_pay_period_part_time_and_daily_pay():
    assert shifts.kind(post("Нужен официант, 12 000 тг за смену, 2/2")) == "day"
    assert shifts.kind(post("Грузчик, 2 000 тг в час")) == "hour"
    assert shifts.kind(post("Требуется бариста на подработку по выходным, 150 000 тг")) == "part"
    assert shifts.kind(post("Требуется кассир, ежедневная оплата, 250 000 тг в месяц")) == "daily"
    assert shifts.kind(post("Повар, 300 000 тг в месяц, 5/2")) is None


def test_shift_perk_added_only_to_shifts():
    assert shifts.perks(post("Официант, 12 000 тг за смену")) [-1] == shifts.SHIFT
    assert shifts.SHIFT not in shifts.perks(post("Повар, 300 000 тг в месяц"))


def test_part_time_words_and_negations():
    assert parse_schedule("Уборщица, разовая работа (сегодня и завтра)") == "подработка"
    assert parse_schedule("Требуются на временную работу на 2 месяца") == "подработка"
    assert parse_schedule("Студентов и на подработку не беспокоить") is None
    assert parse_schedule("❌ студентам и на подработку — не рассматриваем") is None


def test_hh_part_time_employment_is_part_time():
    v = hh.to_vacancy(item(7, employment={"id": "part", "name": "Частичная занятость"}))
    assert v.schedule == "Сменный график, подработка"
    assert shifts.kind(v) == "part"
    assert hh.to_vacancy(item(8, employment_form={"id": "PART"})).schedule.endswith("подработка")
    assert hh.to_vacancy(item(9)).schedule == "Сменный график"


def test_subscription_to_shifts():
    sub = Subscription(1, "almaty", [], [shifts.SHIFT], 0)
    assert digest.matches(sub, post("Официант, 12 000 тг за смену"))
    assert not digest.matches(sub, post("Повар, 300 000 тг в месяц"))


def test_shift_from_bot_is_a_slot_with_take_link():
    from vacante import direct
    job = {"id": 9, "kind": "shift", "city": "almaty", "title": "официант", "company": "Кафе «Зерно»",
           "salary": "12 000 ₸ за смену", "schedule": "Смена 07.11, 10:00–22:00", "address": "Абая, 10",
           "details": "", "approved_at": "2026-11-06 07:00:00", "shift_date": "2026-11-07", "shift_start": "10:00",
           "shift_end": "22:00", "need": 3}
    v = direct.to_vacancy(job)
    assert shifts.kind(v) == "slot"
    assert v.source_url == "https://t.me/vacantekz_bot?start=take_9"
    assert (v.shift_date, v.shift_time, v.need, v.salary_period, v.salary_min) == ("2026-11-07", "10:00–22:00", 3, "day", 12000)
    assert shifts.day_label("2026-11-07") == "сб, 07.11"
    assert shifts.day_label("2026-11-07", "kk") == "сн, 07.11"
    plain = direct.to_vacancy({**job, "kind": "vacancy"})
    assert plain.shift_date is None and "apply_9" in plain.source_url


def test_morning_digest_once_a_day_for_shift_subscribers(tmp_path):
    from vacante.store import save_vacancies
    now = datetime(2026, 11, 6, 3, 30, tzinfo=timezone.utc)  # 8:30 в Казахстане
    v = post("Нужен официант, 12 000 тг за смену, 2/2")
    v.posted_at = (now.replace(hour=1)).isoformat()
    save_vacancies(tmp_path, [v])
    sent = []
    subs = [Subscription(1, "almaty", [], [shifts.SHIFT], 0), Subscription(2, "almaty", [], [], 0)]
    digest.run(tmp_path, "https://vacante.kz", lambda: subs, lambda *a: sent.append(a), now=now)  # первый запуск
    digest.run(tmp_path, "https://vacante.kz", lambda: subs, lambda *a: sent.append(a), now=now)
    assert [s[0] for s in sent] == [1]
    assert sent[0][1].startswith("☀️ Доброе утро! Смены и подработка на сегодня: 1")
    assert "https://vacante.kz/almaty/smeny/" in sent[0][1]
    digest.run(tmp_path, "https://vacante.kz", lambda: subs, lambda *a: sent.append(a), now=now.replace(hour=5))
    assert len(sent) == 1  # второй раз за день не шлём


def test_channel_shifts_digest_needs_three_and_lists_slots_first():
    from vacante import autopost, direct
    now = datetime(2026, 11, 6, 14, tzinfo=timezone.utc)  # 19:00
    items = []
    for i in range(3):
        v = post(f"Нужен грузчик №{i}, 2 000 тг в час")
        v.id, v.posted_at, v.source = f"hh-{i}", now.isoformat(), "hh"
        items.append(v)
    slot = direct.to_vacancy({"id": 9, "kind": "shift", "city": "almaty", "title": "официант", "company": "Кафе",
                              "salary": "12 000 ₸ за смену", "approved_at": "2026-11-06 07:00:00",
                              "shift_date": "2026-11-07", "shift_start": "10:00", "shift_end": "22:00", "need": 2})
    allowed = lambda v: v.source in ("hh", "bot")  # noqa: E731
    assert autopost.shifts_digest(items[:2], "almaty", "https://vacante.kz", now, allowed) is None
    text = autopost.shifts_digest(items + [slot], "almaty", "https://vacante.kz", now, allowed)
    assert text.startswith("⚡ <b>Подработка и смены в Алматы: на завтра</b>")
    assert text.index("Официант") < text.index("Грузчик")
    assert "📅 сб, 07.11, 10:00–22:00" in text
    assert "start=smena" in text
    assert autopost.shifts_digest(items, "almaty", "https://vacante.kz", now, lambda v: False) is None

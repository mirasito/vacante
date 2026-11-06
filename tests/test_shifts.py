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

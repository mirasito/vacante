from datetime import datetime, timezone

import pytest

from vacante.models import RawPost
from vacante.parse import (
    clean_text,
    detect_city,
    detect_employer,
    detect_titles,
    is_vacancy,
    parse_perks,
    parse_post,
    parse_salary,
    parse_schedule,
)

WAITER = """Ресторан Ramen77 ищет официанта

Опыт работы обязателен, от 18 лет, не студент
Оплата 14 000–18 000 тг в день
График 2/2 с 10:00 до 23:00
Питание и развозка

Тел: +7 701 123 45 67"""

SMALL = """Сеть супермаркетов SMALL приглашает на работу:
— продавец-универсал, 205 000 тг на руки
— оператор сборки, 200 000 тг на руки
График 2/2
WhatsApp: 8 777 765 43 21

Подписывайтесь на канал @almatyrabota1"""


def post(text: str, city: str | None = "almaty") -> RawPost:
    return RawPost("telegram", "almatyrabota1", 1, "https://t.me/almatyrabota1/1", text,
                   datetime(2026, 10, 27, tzinfo=timezone.utc), city)


@pytest.mark.parametrize("text, expected", [
    ("Оплата 14 000–18 000 тг в день", (14_000, 18_000, "day")),
    ("продавец-универсал, 205 000 тг на руки", (205_000, None, "month")),
    ("оклад 350 000 тг + бонусы", (350_000, None, "month")),
    ("оплата 1000 тг в час, возраст 18–27 лет", (1_000, None, "hour")),
    ("ЗП от 250 до 400 тыс", (250_000, 400_000, "month")),
    ("Зарплата 300к", (300_000, None, "month")),
    ("зп до 500.000 тенге", (None, 500_000, "month")),
    ("за смену 12000", (12_000, None, "day")),
    ("возраст 18-35 лет, график 5/2", (None, None, None)),
    ("звоните 8 701 123 45 67, зарплата договорная", (None, None, None)),
])
def test_parse_salary(text, expected):
    assert parse_salary(text) == expected


def test_titles_prefer_specific_and_keep_order():
    assert detect_titles(SMALL) == [("Продавец-универсал", "retail"), ("Сборщик заказов", "warehouse")]
    assert detect_titles("Требуется помощник повара и посудомойщица") == [
        ("Помощник повара", "horeca"), ("Посудомойщица", "horeca")]


def test_schedule_and_perks():
    assert parse_schedule(WAITER) == "2/2"
    assert parse_schedule("Вахта 15/15, проживание") == "15/15, вахта"
    assert parse_perks(WAITER) == ["Питание", "Развозка"]
    assert "Можно студентам" in parse_perks("Курьер, можно студентам, ежедневная оплата")
    assert "Можно студентам" not in parse_perks(WAITER)


def test_city_detection():
    assert detect_city("Требуется повар в Астане", "almaty") == "astana"
    assert detect_city("Требуется повар", "almaty") == "almaty"
    assert detect_city("Филиалы в Алматы и Астане", None) is None


def test_employer():
    assert detect_employer(WAITER) == "Ramen77"
    assert detect_employer(SMALL) == "SMALL"
    assert detect_employer("В кофейню «Зерно» требуется бариста") == "Зерно"


@pytest.mark.parametrize("text", [
    "Ищу работу официантом, опыт 3 года",
    "Сдам комнату, требуется только оплата",
    "Работа в телефоне без вложений! Доход от 20 000 тг в день, нужен курьер",
    "Требуются курьеры-закладчики, оплата высокая",
    "Работа в Южную Корею, нужен разнорабочий, 900 000 тг",
    "Всем доброе утро, хорошего дня!",
])
def test_rejects_non_vacancies(text):
    assert not is_vacancy(text)


def test_clean_text_strips_contacts_and_promo():
    cleaned = clean_text(SMALL)
    assert "765" not in cleaned
    assert "@almatyrabota1" not in cleaned
    assert "Подписывайтесь" not in cleaned
    assert cleaned.startswith("Сеть супермаркетов SMALL")


def test_parse_post_builds_card():
    v = parse_post(post(WAITER))
    assert v is not None
    assert (v.title, v.category, v.city) == ("Официант", "horeca", "almaty")
    assert (v.salary_min, v.salary_max, v.salary_period) == (14_000, 18_000, "day")
    assert v.schedule == "2/2"
    assert v.employer == "Ramen77"
    assert "701" not in v.text
    assert v.id == "almatyrabota1-1"

    small = parse_post(post(SMALL))
    assert small.title == "Продавец-универсал, Сборщик заказов"
    assert small.category == "retail"


def test_employer_stays_on_its_line():
    assert detect_employer("KARI ищет администратора магазина\nОклад 350 000 тг") is None


def test_generic_staff_falls_back_to_other():
    v = parse_post(post("Сеть игровых площадок Play Smart ищет сотрудника\nГрафик 5/2\nОклад 350 000 тг"))
    assert (v.title, v.category, v.employer) == ("Сотрудник", "other", "Play Smart")

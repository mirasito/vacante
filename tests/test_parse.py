from datetime import datetime, timezone

import pytest

from vacante.models import RawPost
from vacante.parse import (
    clean_text,
    detect_address,
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


def test_schedule_ignores_house_numbers():
    assert parse_schedule("Адрес: ул. Шаймердена, 11/4\nГрафик сменный") is None
    assert parse_schedule("График работы: 14/2") == "14/2"


def test_employer_from_labels_and_invites():
    assert detect_employer("✅ Название компании: Coffee Boom ☕\nТребуется повар") == "Coffee Boom"
    assert detect_employer("🏭 Saitama_Japan приглашает на работу (Алматы)") == "Saitama_Japan"
    assert detect_employer("Компания: Не указана\nТребуется грузчик") is None
    assert detect_employer("Работодатель: Администратор\nНужен кассир") is None


@pytest.mark.parametrize("text", [
    "Требуется инженер по охране труда, водитель служебного авто, 300 000 тг",
    "Супервайзер в отдел взыскания, удалённо. Доход: $1,300 – 2,400. Нужен курьер документов",
    "Требуется официант в ресторан в Ташкенте, оплата 5 000 000 сум",
    "Требуются официантки в ночной клуб в Анкаре, перелёт и жильё за счёт работодателя, 3000$",
    "#вахтаРоссия Требуются разнорабочие на завод, 23 000 тенге за смену. Выезд из города #Костанай",
])
def test_rejects_white_collar_and_foreign(text):
    assert parse_post(post(text)) is None


def test_keeps_blue_collar_near_misleading_words():
    assert parse_post(post("Требуется грузчик, командировки в Россию раз в неделю, 300 000 тг")) is not None
    assert parse_post(post("Требуются помощники воспитателя (няни), 200 000 тг")).title == "Помощник воспитателя, Няня"
    shop = parse_post(post("Магазин на Ташкентском тракте: требуется продавец, 250 000 тг"))
    assert shop is not None and shop.city == "almaty"


def test_salary_ignores_foreign_currency():
    assert parse_salary("Доход: $1,300 – 2,400 на руки") == (None, None, None)


def test_generic_title_only_without_specific_one():
    assert detect_titles("Требуются\nработники в цех, 300 000 тг") == [("Сотрудник", "other")]
    assert detect_titles("Требуются сотрудники: кассир") == [("Кассир", "retail")]


def test_students_perk_respects_refusal():
    assert "Можно студентам" in parse_perks("Подходит студентам, гибкий график")
    assert "Можно студентам" not in parse_perks("Студентов очного отделения просьба не беспокоить")


def test_employer_stops_before_invite_verb():
    assert detect_employer("🔥 СЕТЬ СУПЕРМАРКЕТОВ SMALL ПРИГЛАШАЕТ В КОМАНДУ! 🔥") == "SMALL"


@pytest.mark.parametrize("text, expected", [
    ("Бариста\n📍 Адрес: г. Астана, Есильский район, пр. Мангилик Ел, 49 (ЖК «Дрим Сити»)",
     "пр. Мангилик Ел, 49 (ЖК «Дрим Сити»)"),
    ("Бариста\n▫️ Адрес: ул. Сыганак, 2; ул. Кенесары, 47", "ул. Сыганак, 2"),
    ("Адрес:\nАлматы, Жароков көшесі, 20", "Жароков көшесі, 20"),
    ("📌Адреса для собеседования: ТРЦ «Хан Шатыр»", "ТРЦ «Хан Шатыр»"),
    ("📍ул. Розыбакиева 181А (р-н MEGA)", "ул. Розыбакиева 181А (р-н MEGA)"),
    ("📍 Место работы: Кульджинский тракт, 106", "Кульджинский тракт, 106"),
    ("📍 График работы: 2/2", None),
    ("▫️ Адрес: 6 точек по городу", None),
    ("• Адресіңіз барынша жұмысқа жақын болуы керек", None),
    ("Адрес: Алматы, Бостандыкский район", "Бостандыкский район"),
    ("Отправьте резюме на адрес: hr@cafe.kz", None),
])
def test_address(text, expected):
    assert detect_address(text) == expected


# Профессии, которые раньше отбрасывались как «нет рабочей профессии» (по журналу сбора)
@pytest.mark.parametrize("text, title, category", [
    ("🧰 Вакансия: Пиццер 💰 З/п: 12 000 – 13 500 ₸ за смену", "Пиццамейкер", "horeca"),
    ("Требуются ! Шашлычник мариновщик-20К 2/2", "Шашлычник", "horeca"),
    ("Требуется кухрабочая, ночная смена, 10 000 тг", "Кухонный работник", "horeca"),
    ("Требуется сборщик бургеров в фастфуд, 9 000 тг за смену", "Сборщик бургеров", "horeca"),
    ("ПАРФЮМЕРИЯҒА САТУШЫ ҚАЖЕТ! Жалақы 200 000 тг", "Продавец", "retail"),
    ("MTREND дүкеніне сатушы-кеңесші қажет! Жалақы 250 000 тг", "Продавец-консультант", "retail"),
    ("В цветочный магазин требуется флорист с опытом, 2/2", "Флорист", "retail"),
    ("В Торговую Компанию требуется ТОРГОВЫЙ ПРЕДСТАВИТЕЛЬ на регион", "Торговый представитель", "retail"),
    ("СРОЧНО ТРЕБУЮТСЯ ОПЫТНЫЕ ЛЕПЩИКИ, ЛЕПЩИЦЫ, от 350 000 ₸", "Лепщица", "warehouse"),
    ("СРОЧНО ТРЕБУЕТСЯ: СБОРЩИК КОРПУСНОЙ МЕБЕЛИ", "Мебельщик", "warehouse"),
    ("Требуется оператор лазерного станка и плазменной резки по металлу", "Оператор станков", "warehouse"),
    ("Pindomarket: Жұмысшылар керек! Жалақы 250 000", "Рабочий", "warehouse"),
    ("В продуктовый магазин требуется Охрана (СБ), парни с 18 лет", "Охранник", "service"),
    ("Требуется заправщик на АЗС, 14 000 ₸ / смена", "Заправщик", "service"),
    ("В салон красоты требуется мастер маникюра, оплата 50/50", "Мастер маникюра", "service"),
    ("Требуется на постоянную работу технический персонал для уборки кинотеатра", "Технический персонал", "service"),
    ("Требуется ходовик на СТО, теплые боксы", "Автомеханик", "construction"),
    ("Требуется 1 строитель универсал для строительства бани", "Строитель", "construction"),
    ("Требуется оператор гусеничного экскаватора Hitachi", "Машинист спецтехники", "construction"),
    ("Шаруа қожалығына МАЛШЫ қажет! Жалақы 200 000", "Пастух", "other"),
    ("Требуются на работу контролеры общественного транспорта", "Кондуктор", "other"),
])
def test_more_blue_collar_professions(text, title, category):
    v = parse_post(post(text))
    assert v is not None and v.title.split(", ")[0] == title and v.category == category


@pytest.mark.parametrize("text", [
    "В пиццерию требуется кассир, 10 000 тг за смену",
    "В шашлычную требуется официант, 2/2",
    "Требуется официант, 300 000 тг. Соблюдаем охрану труда",
])
def test_new_words_do_not_steal_titles(text):
    assert parse_post(post(text)).title in {"Кассир", "Официант"}


def test_channel_host_is_not_a_driver():
    assert parse_post(post("infoLogia Telegram-арна жүргізушісі қажет, Астана")) is None

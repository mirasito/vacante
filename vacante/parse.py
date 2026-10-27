"""Разбор свободного текста поста в карточку вакансии.

Работает на правилах и словарях, без платных ИИ-моделей: этого хватает для типичных
постов в духе «Требуется официант, 2/2, 14 000 тг в день, питание и развозка».
"""

from __future__ import annotations

import hashlib
import re

from vacante.models import RawPost, Vacancy

CATEGORIES = {
    "horeca": "Кафе и рестораны",
    "retail": "Магазины и продажи",
    "warehouse": "Склад и производство",
    "delivery": "Доставка и водители",
    "service": "Сервис и уборка",
    "construction": "Стройка и ремонт",
    "callcenter": "Колл-центр",
    "other": "Другое",
}

CITIES = {
    "almaty": ("Алматы", r"алмат|алма-ат|almaty"),
    "astana": ("Астана", r"астан|нур-султан|astana"),
    "shymkent": ("Шымкент", r"шымкент"),
    "karaganda": ("Караганда", r"караганд"),
    "aktobe": ("Актобе", r"актобе"),
    "atyrau": ("Атырау", r"атырау"),
    "aktau": ("Актау", r"актау"),
    "pavlodar": ("Павлодар", r"павлодар"),
    "ust-kamenogorsk": ("Усть-Каменогорск", r"усть-каменогорск|оскемен"),
    "semey": ("Семей", r"\bсемей"),
    "kostanay": ("Костанай", r"костана"),
    "uralsk": ("Уральск", r"уральск|орал\b"),
    "taraz": ("Тараз", r"тараз"),
    "turkestan": ("Туркестан", r"туркестан"),
    "petropavlovsk": ("Петропавловск", r"петропавловск"),
    "kyzylorda": ("Кызылорда", r"кызылорд"),
}

# (регулярка по тексту в нижнем регистре, название должности, категория).
# При нескольких совпадениях берётся то, что раньше всех встречается в тексте,
# а на одной позиции — самое длинное («продавец-консультант» сильнее «продавец»).
PROFESSIONS: list[tuple[str, str, str]] = [
    # Кафе и рестораны
    (r"помощни(к|ца|ка|цу) повар", "Помощник повара", "horeca"),
    (r"шеф-повар|су-?шеф", "Шеф-повар", "horeca"),
    (r"повар", "Повар", "horeca"),
    (r"пекар", "Пекарь", "horeca"),
    (r"кондитер", "Кондитер", "horeca"),
    (r"официант", "Официант", "horeca"),
    (r"бармен", "Бармен", "horeca"),
    (r"бариста", "Бариста", "horeca"),
    (r"хостес", "Хостес", "horeca"),
    (r"посудомо|мойщи(к|ца|цу) посуд", "Посудомойщица", "horeca"),
    (r"кальянщ", "Кальянщик", "horeca"),
    (r"раннер", "Раннер", "horeca"),
    (r"сушист", "Сушист", "horeca"),
    (r"пицц?а-?мейкер", "Пиццамейкер", "horeca"),
    (r"шаурм", "Шаурмист", "horeca"),
    # Магазины и продажи
    (r"продав\w*[- ]консультант", "Продавец-консультант", "retail"),
    (r"продав\w*[- ]кассир", "Продавец-кассир", "retail"),
    (r"продав\w*[- ]универсал", "Продавец-универсал", "retail"),
    (r"продав", "Продавец", "retail"),
    (r"кассир", "Кассир", "retail"),
    (r"мерчендайзер", "Мерчендайзер", "retail"),
    (r"администратор\w* магазин", "Администратор магазина", "retail"),
    (r"пункт\w* выдачи|\bпвз\b", "Сотрудник пункта выдачи", "retail"),
    (r"менеджер\w* по продаж", "Менеджер по продажам", "retail"),
    (r"менеджер\w* по работе с клиент", "Менеджер по работе с клиентами", "retail"),
    (r"консультант", "Консультант", "retail"),
    # Склад и производство
    (r"кладовщ", "Кладовщик", "warehouse"),
    (r"комплектовщ|сборщи\w* заказ|оператор\w* сборки", "Сборщик заказов", "warehouse"),
    (r"упаковщ|фасовщ", "Упаковщик", "warehouse"),
    (r"грузчик", "Грузчик", "warehouse"),
    (r"разнорабоч", "Разнорабочий", "warehouse"),
    (r"\bшве(я|ю|и)\b|швейн\w* цех", "Швея", "warehouse"),
    (r"рабоч\w* на производств", "Рабочий на производство", "warehouse"),
    # Доставка и водители
    (r"курьер", "Курьер", "delivery"),
    (r"водител\w* такси|таксист", "Водитель такси", "delivery"),
    (r"водител", "Водитель", "delivery"),
    (r"экспедитор", "Экспедитор", "delivery"),
    # Сервис и уборка
    (r"уборщ|клинер|техничк", "Уборщица", "service"),
    (r"горничн", "Горничная", "service"),
    (r"\bнян(я|ю|и)\b", "Няня", "service"),
    (r"сиделк", "Сиделка", "service"),
    (r"автомойщ|мойщи\w* (авто|машин)", "Автомойщик", "service"),
    (r"охранни|сотрудни\w* охраны", "Охранник", "service"),
    (r"дворник", "Дворник", "service"),
    (r"гардеробщ", "Гардеробщик", "service"),
    (r"парикмахер|барбер", "Парикмахер", "service"),
    (r"администратор", "Администратор", "service"),
    # Стройка и ремонт
    (r"электрик|электромонт", "Электрик", "construction"),
    (r"сварщ", "Сварщик", "construction"),
    (r"сантехник", "Сантехник", "construction"),
    (r"автослесар|автомеханик", "Автомеханик", "construction"),
    (r"слесар", "Слесарь", "construction"),
    (r"маляр", "Маляр", "construction"),
    (r"плиточник", "Плиточник", "construction"),
    (r"каменщик", "Каменщик", "construction"),
    (r"монтажник", "Монтажник", "construction"),
    (r"отделочник", "Отделочник", "construction"),
    (r"экскаваторщ|крановщ|машинист", "Машинист спецтехники", "construction"),
    # Колл-центр
    (r"оператор\w* (колл|call)|колл-центр|call-центр|кол-центр", "Оператор колл-центра", "callcenter"),
    # Общие слова: срабатывают, только если конкретной должности в тексте нет раньше
    (r"сотрудни(к|ка|ца|цу|цы|ков)\b", "Сотрудник", "other"),
]
_PROFESSIONS = [(re.compile(p), title, cat) for p, title, cat in PROFESSIONS]

HIRING = re.compile(
    r"требу[ею]т|ищ[еу]м|ищет|нуж(ен|на|ны)|ваканси|набор|приглаша|в поиске|срочно|на работу"
)
NOT_VACANCY = re.compile(
    r"ищу работу|#резюме|^резюме|рассмотрю (любые )?предложения|"
    r"\bсда(м|ю|ется|ются)\b|\bпрода(м|ю|ется)\b|\bкуплю\b|\bаренд"
)
SCAM = re.compile(
    r"без вложени|пассивн\w* доход|онлайн[- ]?заработ|заработ\w* в интернет|работа в телефоне|"
    r"крипт|трейдинг|ставк\w* на спорт|букмекер|закладк|кладмен|закладчик|"
    r"за рубеж|в европ|в польш|(южную )?корею|сетев\w* маркетинг|\bмлм\b|\bmlm\b|"
    r"вебкам|webcam|эскорт|интим|предоплат|оплатить обучение|вступительн\w* взнос"
)

PERKS = [
    ("Питание", r"питани|кормим|бесплатн\w* обед|обед\w* за сч[её]т"),
    ("Развозка", r"развоз|такси (после|до дома)|доставка до дома"),
    ("Жильё", r"проживани|жиль[её]|общежити"),
    ("Спецодежда", r"спецодежд|униформ|форм\w* выда|форм\w* предоставл"),
    ("Официально", r"официальн\w* (трудоустр|оформлени)|оформлени\w* по тк|соцпакет"),
    ("Обучение", r"обучени|обучим|стажировк"),
    ("Без опыта", r"без опыта|опыт не (обязател|нуж|требу)"),
    ("Ежедневная оплата", r"ежедневн\w* (оплат|выплат)|оплата каждый день|расч[её]т каждый день"),
]
_PERKS = [(name, re.compile(p)) for name, p in PERKS]
_FOR_STUDENTS = re.compile(r"(?<!не )студент")

_NUM = r"\d{1,3}(?:[   .,]\d{3})+|\d+"
_MULT = r"\s*(?:к|k|тыс\.?|тысяч[аи]?)(?![а-яa-z])"
SALARY = re.compile(
    rf"(?P<a>{_NUM})(?P<am>{_MULT})?"
    rf"(?:\s*(?:-|–|—|до)\s*(?P<b>{_NUM})(?P<bm>{_MULT})?)?"
    r"(?=(?P<tail>[^\n]{0,30}))"
)
_CURRENCY = re.compile(r"^\s*(тг|тенге|₸|kzt|tg)", re.I)
_MONEY_CONTEXT = re.compile(r"зп|з/п|зарплат|оклад|оплат|доход|ставк|платим|выплат|смен")
_NOT_MONEY_TAIL = re.compile(r"^\s*(лет|год|:\d|/\s*\d|%|шт|кг|м\b|км|мин|чел|ч\b|час(а|ов)\b)")
_LIMITS = {"hour": (300, 15_000), "day": (2_000, 150_000), "month": (40_000, 5_000_000)}

_SCHEDULE = re.compile(r"(?<![\d/])(\d{1,2})\s*/\s*(\d{1,2})(?![\d/])")
_EMPLOYER_QUOTED = re.compile(r"[«\"]([^«»\"\n]{2,40})[»\"]")
_EMPLOYER_PLACE = re.compile(
    r"(?i:\b(?:кафе|ресторан\w*|кофейн\w*|магазин\w*|бар\w*|сет(ь|и)(?:[ \t]+[а-яё]+){1,3}|компани\w*|супермаркет\w*|"
    r"пекарн\w*|столов\w*|пункт\w* выдачи|салон\w*|отел\w*|гостиниц\w*))[ \t]+"
    r"([A-ZА-ЯЁ][\w&'’.-]*(?:[ \t]+[A-ZА-ЯЁ0-9][\w&'’.-]*){0,2})"
)

_PHONE = re.compile(r"(?:\+?[78][\s(-]*)?\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}")
_LINK = re.compile(r"https?://\S+|t\.me/\S+|wa\.me/\S+|@\w{4,}")
_PROMO_LINE = re.compile(
    r"подпис|разместить ваканси|размещени\w* ваканси|реклам|по вопросам|наш канал|поделись", re.I
)


def _lower(text: str) -> str:
    return text.lower().replace("ё", "е")


def is_vacancy(text: str) -> bool:
    low = _lower(text)
    if NOT_VACANCY.search(low) or SCAM.search(low):
        return False
    has_profession = any(rx.search(low) for rx, _, _ in _PROFESSIONS)
    return has_profession and (bool(HIRING.search(low)) or parse_salary(text)[0] is not None)


def detect_titles(text: str) -> list[tuple[str, str]]:
    """Должности в порядке появления в тексте: [(название, категория), ...]."""
    low = _lower(text)
    hits = []
    for rx, title, cat in _PROFESSIONS:
        for m in rx.finditer(low):
            hits.append((m.start(), -(m.end() - m.start()), title, cat))
    hits.sort()
    result: list[tuple[str, str]] = []
    covered_until = -1
    for start, neg_len, title, cat in hits:
        if start < covered_until:
            continue  # «консультант» внутри уже найденного «продавец-консультант»
        covered_until = start - neg_len
        if all(t != title for t, _ in result):
            result.append((title, cat))
    return result


def _to_int(num: str) -> int:
    return int(re.sub(r"[   .,]", "", num))


def parse_salary(text: str) -> tuple[int | None, int | None, str | None]:
    """Первая сумма, похожая на зарплату: (минимум, максимум, период)."""
    low = _lower(_PHONE.sub(" ", text))
    for m in SALARY.finditer(low):
        a_raw, b_raw, tail = m["a"], m["b"], m["tail"]
        if len(re.sub(r"\D", "", a_raw)) >= 9 or _NOT_MONEY_TAIL.match(tail):
            continue  # телефон, возраст, время, график
        if b_raw and _NOT_MONEY_TAIL.match(low[m.end("b"):]):
            continue
        line_start = low.rfind("\n", 0, m.start()) + 1
        head = low[max(line_start, m.start() - 40): m.start()]
        mult = bool(m["am"] or m["bm"])
        if not (_CURRENCY.match(tail) or mult or _MONEY_CONTEXT.search(head)):
            continue
        a = _to_int(a_raw) * (1000 if m["am"] else 1)
        b = _to_int(b_raw) * (1000 if m["bm"] else 1) if b_raw else None
        if m["bm"] and not m["am"] and a < 1000:
            a *= 1000  # «от 250 до 400 тыс»
        context = tail + " " + head[-15:]
        if re.search(r"час", context):
            period = "hour"
        elif re.search(r"день|дн\b|смен|сутк", context):
            period = "day"
        elif re.search(r"мес", context):
            period = "month"
        else:
            period = "hour" if a < 3_000 else "day" if a < 40_000 else "month"
        lo, hi = _LIMITS[period]
        if not lo <= a <= hi or (b is not None and not lo <= b <= hi):
            continue
        if b is not None and b < a:
            a, b = b, a
        if head.rstrip().endswith("до"):
            return None, b or a, period
        return a, b, period
    return None, None, None


def parse_schedule(text: str) -> str | None:
    low = _lower(text)
    parts = []
    for m in _SCHEDULE.finditer(low):
        work, rest = int(m[1]), int(m[2])
        if 1 <= work <= 30 and 1 <= rest <= 30 and work + rest <= 60:
            parts.append(f"{work}/{rest}")
            break
    if "вахт" in low:
        parts.append("вахта")
    if re.search(r"ночн\w* смен", low):
        parts.append("ночные смены")
    if "подработ" in low:
        parts.append("подработка")
    return ", ".join(parts) or None


def parse_perks(text: str) -> list[str]:
    low = _lower(text)
    perks = [name for name, rx in _PERKS if rx.search(low)]
    if _FOR_STUDENTS.search(low) and "не студент" not in low:
        perks.append("Можно студентам")
    return perks


def detect_city(text: str, default: str | None) -> str | None:
    low = _lower(text)
    found = [slug for slug, (_, rx) in CITIES.items() if re.search(rx, low)]
    if len(found) == 1:
        return found[0]
    if not found:
        return default
    return default if default in found else None


def detect_employer(text: str) -> str | None:
    m = _EMPLOYER_QUOTED.search(text)
    if m:
        return m[1].strip()
    m = _EMPLOYER_PLACE.search(text)
    if m:
        return m[2].strip(" .,")
    return None


def clean_text(text: str) -> str:
    """Убирает контакты, ссылки и рекламные хвосты каналов: откликаются в источнике."""
    lines = []
    for line in text.splitlines():
        if _PROMO_LINE.search(line):
            continue
        line = _PHONE.sub("", line)
        line = _LINK.sub("", line)
        line = re.sub(r"[ \t]{2,}", " ", line).rstrip(" :,-–")
        lines.append(line)
    cleaned = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    return cleaned[:1500]


def word_set(text: str) -> set[str]:
    return {w for w in re.findall(r"[а-яa-z0-9]+", _lower(text)) if len(w) >= 3}


def fingerprint(text: str) -> str:
    return hashlib.sha1(" ".join(sorted(word_set(text))).encode()).hexdigest()[:16]


def parse_post(post: RawPost) -> Vacancy | None:
    """RawPost → Vacancy, или None, если это не вакансия."""
    if not is_vacancy(post.text):
        return None
    titles = detect_titles(post.text)
    if not titles:
        return None
    title = ", ".join(t for t, _ in titles[:3])
    salary_min, salary_max, period = parse_salary(post.text)
    text = clean_text(post.text)
    return Vacancy(
        id=f"{post.channel.lower()}-{post.post_id}",
        title=title,
        category=titles[0][1],
        city=detect_city(post.text, post.default_city),
        salary_min=salary_min,
        salary_max=salary_max,
        salary_period=period,
        schedule=parse_schedule(post.text),
        perks=parse_perks(post.text),
        employer=detect_employer(post.text),
        text=text,
        source=post.source,
        source_url=post.url,
        posted_at=post.posted_at.isoformat(),
        fingerprint=fingerprint(text),
    )

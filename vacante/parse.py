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
    "semey": ("Семей", r"\bсемей(?!н|ств)"),  # не «семейный ресторан»
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
    (r"шеф-повар|су[- ]?шеф", "Шеф-повар", "horeca"),
    (r"повар", "Повар", "horeca"),
    (r"пекар", "Пекарь", "horeca"),
    (r"кондитер", "Кондитер", "horeca"),
    (r"официант", "Официант", "horeca"),
    (r"бармен", "Бармен", "horeca"),
    (r"бариста", "Бариста", "horeca"),
    (r"хостес", "Хостес", "horeca"),
    (r"посудомо|мойщи(к|ца|цу) посуд|посудниц", "Посудомойщица", "horeca"),
    (r"кальянщ", "Кальянщик", "horeca"),
    (r"(?<![а-я])ран?нер", "Раннер", "horeca"),
    (r"сушист", "Сушист", "horeca"),
    (r"пицц?а-?мейкер|пиццер(?!и)|пиццерист|пиццайол", "Пиццамейкер", "horeca"),
    (r"шаурм|донерщ|донер жасайтын", "Шаурмист", "horeca"),
    (r"шашлычни[кц]|мангальщ", "Шашлычник", "horeca"),
    (r"кухрабоч|кухонн\w* (?:работни|рабоч)|асхана жуушы", "Кухонный работник", "horeca"),
    (r"заготовщ", "Заготовщик", "horeca"),
    (r"сборщи\w* (?:бургер|шаурм|ролл|пицц|донер|сэндвич)", "Сборщик бургеров", "horeca"),
    (r"аспаз", "Повар", "horeca"),
    (r"даяшы", "Официант", "horeca"),
    (r"раздатчиц|раздатчик", "Раздатчица", "horeca"),
    (r"салатниц|(?:работни|повар)\w* (?:на |в )?холодн\w* цех", "Повар холодного цеха", "horeca"),
    (r"мясник|обвальщ", "Мясник", "horeca"),
    # Магазины и продажи
    (r"продав\w*[- ]консультант", "Продавец-консультант", "retail"),
    (r"продав\w*[- ]кассир", "Продавец-кассир", "retail"),
    (r"продав\w*[- ]универсал", "Продавец-универсал", "retail"),
    (r"продав|продовец|продовц", "Продавец", "retail"),
    (r"сатушы[- ]?ке[ңн]есші", "Продавец-консультант", "retail"),
    (r"сатушы", "Продавец", "retail"),
    (r"помощни\w* по зал", "Помощник по залу", "retail"),
    (r"флорист", "Флорист", "retail"),
    (r"торгов\w* представител", "Торговый представитель", "retail"),
    (r"кассир", "Кассир", "retail"),
    (r"мерчендайзер", "Мерчендайзер", "retail"),
    (r"помощни(?:ца|цу|к|ка) в (?:\w+ )?магазин", "Помощник по залу", "retail"),
    (r"администратор\w* магазин", "Администратор магазина", "retail"),
    (r"пункт\w* выдачи|\bпвз\b", "Сотрудник пункта выдачи", "retail"),
    (r"менеджер\w* по продаж", "Менеджер по продажам", "retail"),
    (r"менеджер\w* по работе с клиент", "Менеджер по работе с клиентами", "retail"),
    (r"консультант", "Консультант", "retail"),
    (r"(?:эксперт|менеджер)[- ]оценщи|оценщи\w* (?:в |ломбард)", "Оценщик в ломбард", "retail"),
    # Склад и производство
    (r"кладовщ", "Кладовщик", "warehouse"),
    (r"комплектовщ|сборщи\w* заказ|оператор\w* сборки", "Сборщик заказов", "warehouse"),
    (r"упаковщ|фасовщ", "Упаковщик", "warehouse"),
    (r"грузчик", "Грузчик", "warehouse"),
    (r"разнорабоч", "Разнорабочий", "warehouse"),
    (r"\bшве(я|ю|и)\b|швейн\w* цех", "Швея", "warehouse"),
    (r"рабоч\w* на производств", "Рабочий на производство", "warehouse"),
    (r"шлифовщ", "Шлифовщик", "warehouse"),
    (r"сканерщ", "Сканерщик", "warehouse"),
    (r"(?<![а-я])портн(?:ой|ая|ого|ую|их|иха)\b", "Портной", "warehouse"),
    (r"(?:служащ|работни|сотрудни|рабоч(?:ий|ие|их))\w* (?:на |в )?(?:\w+ )?склад|склад\w*(?: \w+)? требу\w* помощни",
     "Работник склада", "warehouse"),
    (r"сборщи(?:к|ца|ки|цы|ков)\b", "Сборщик", "warehouse"),
    (r"лепщи", "Лепщица", "warehouse"),
    (r"формовщ", "Формовщик", "warehouse"),
    (r"мебельщ|мастер\w* по (?:мягкой |корпусной )?мебел|сборщи\w* (?:\w+ )?мебел|обивщ", "Мебельщик", "warehouse"),
    (r"распиловщ|раскройщ", "Распиловщик", "warehouse"),
    (r"токар(?:ь|я|ю|и|ей)\b", "Токарь", "warehouse"),
    (r"фрезеровщ", "Фрезеровщик", "warehouse"),
    (r"оператор\w* (?:\w+ )?(?:станк|чпу|лазер|плазм|пресс)|станочник", "Оператор станков", "warehouse"),
    (r"ж[уұ]мысш[ыі]", "Рабочий", "warehouse"),
    # Доставка и водители
    (r"курьер", "Курьер", "delivery"),
    (r"водител\w* такси|таксист", "Водитель такси", "delivery"),
    (r"водител", "Водитель", "delivery"),
    (r"экспедитор", "Экспедитор", "delivery"),
    (r"ж[үу]ргізуші(?!сі)", "Водитель", "delivery"),  # «арна жүргізушісі» — ведущий канала
    # Сервис и уборка
    (r"уборщ|клинер|техничк|уборк\w* (домов|квартир|офис|помещ)|тазал[ыі][қк]шы", "Уборщица", "service"),
    (r"технич\w* персонал|тех\.? ?персонал", "Технический персонал", "service"),
    (r"помощни\w* воспитател", "Помощник воспитателя", "service"),
    (r"гори?ничн", "Горничная", "service"),
    (r"домработниц|помощни\w* по (?:дому|хозяйств)", "Домработница", "service"),
    (r"санитар(?:ка|ки|ку|очк)", "Санитарка", "service"),
    (r"прачк", "Прачка", "service"),
    (r"дезинфектор|дезинсектор", "Дезинфектор", "service"),
    (r"ресепшн|ресепшен|ресепшионист", "Администратор ресепшн", "service"),
    (r"оператор\w* (?:в |на )?(?:фаст-?фуд|общепит|техосмотр|vr|аттракцион|игров\w* (?:площадк|комнат|зон))|"
     r"оператор\w*[^\n]{0,40}компьютерн\w* клуб|компьютерн\w* клуб[^\n]{0,60}\n*[^\n]{0,20}оператор", "Оператор", "service"),
    (r"\bнян(я|ю|и)\b", "Няня", "service"),
    (r"сиделк", "Сиделка", "service"),
    (r"автомойщ|мо[йи][щш]и\w* (?:на )?(авто|машин)|мойк\w* самообслуж|"
     r"(?<![а-я])мо[йи][щш]ик(?:и|ов|а)?\b(?! (?:на )?(?:посуд|окон|ковр))", "Автомойщик", "service"),
    (r"охран?ни|сотрудни\w* охраны|охран[ауы]\b(?!\s+труд)|к[үу]зетші", "Охранник", "service"),
    (r"оператор\w* видеонаблюд|видеонаблюдени\w*[^\n]{0,30}оператор", "Оператор видеонаблюдения", "service"),
    (r"заправщ", "Заправщик", "service"),
    (r"приемщи", "Приёмщик", "service"),
    (r"мастер\w* (?:маникюр|педикюр|ногтев)|маникюрщ", "Мастер маникюра", "service"),
    (r"бровист|лешмейкер|визажист", "Мастер красоты", "service"),
    (r"помощни\w* мастер", "Помощник мастера", "service"),
    (r"массажист|мастер\w* массаж", "Массажист", "service"),
    (r"садовник", "Садовник", "service"),
    (r"стекольщ|мойщи\w* окон", "Мойщик окон", "service"),
    (r"дворник", "Дворник", "service"),
    (r"банщи", "Банщик", "service"),
    (r"гардеробщ", "Гардеробщик", "service"),
    (r"парикмахер|барбер", "Парикмахер", "service"),
    (r"администратор", "Администратор", "service"),
    # Стройка и ремонт
    (r"электрик|электромонт", "Электрик", "construction"),
    (r"сварщ", "Сварщик", "construction"),
    (r"газорезчик|газорезчиц", "Газорезчик", "construction"),
    (r"шиномонтажник|мастер\w* (?:по )?шиномонтаж", "Шиномонтажник", "construction"),
    (r"проходчик", "Проходчик", "construction"),
    (r"сантехник", "Сантехник", "construction"),
    (r"автослесар|автомеханик|ходовик", "Автомеханик", "construction"),
    (r"механик(?:и|ов|у|а)?\b", "Механик", "construction"),
    (r"слесар", "Слесарь", "construction"),
    (r"маляр", "Маляр", "construction"),
    (r"плиточник", "Плиточник", "construction"),
    (r"каменщик", "Каменщик", "construction"),
    (r"монтажник", "Монтажник", "construction"),
    (r"отделочник", "Отделочник", "construction"),
    (r"столяр(?!н)", "Столяр", "construction"),
    (r"экскаватор|крановщ|машинист|погрузчик|бульдозер|тракторист|автокран|механизатор|каткист|оператор\w* катк",
     "Машинист спецтехники", "construction"),
    (r"строител(?:ь|я|ю|и|ей)\b", "Строитель", "construction"),
    (r"кровельщ", "Кровельщик", "construction"),
    (r"стропальщ", "Стропальщик", "construction"),
    (r"кочегар|оператор\w* котельн", "Кочегар", "construction"),
    (r"мастер\w* (?:по )?детейлинг|оклейщ|пл[её]нщик|мастер\w* по замене масла", "Автомастер", "construction"),
    # Колл-центр
    (r"оператор\w* (колл|call)|колл-центр|call-центр|кол-центр", "Оператор колл-центра", "callcenter"),
    # Прочие рабочие профессии
    (r"пастух|чабан|малшы|[қк]ойшы|сиыршы|скотник|доярк", "Пастух", "other"),
    (r"промоутер|расклейщ", "Промоутер", "other"),
    (r"кондуктор|контролер\w* (?:общественн|в автобус|пассажир)", "Кондуктор", "other"),
    # Общие слова «требуется сотрудник», «нужны работники»: только рядом с глаголом найма,
    # чтобы не ловить «сотрудники компании» в объявлениях и новостях
    (r"(требу\w*|ищ\w+|нуж\w+|приглаша\w*)[\s\S]{0,40}?(сотрудни|работни)(к|ка|ца|цу|цы|ков|ки|ц)\b",
     "Сотрудник", "other"),
    (r"(требу\w*|нуж\w+|ищ\w+)\s+(?:\w+\s+)?рабоч(?:ий|ие|их)\b", "Рабочий", "warehouse"),
]
GENERIC_TITLE = "Сотрудник"
_PROFESSIONS = [(re.compile(p), title, cat) for p, title, cat in PROFESSIONS]
_TITLE_NAMES = {_t.lower() for _, _t, _ in PROFESSIONS}

HIRING = re.compile(
    r"требу[ею]т|ищ[еу]м|ищет|нуж(ен|на|ны)|ваканси|набор|приглаша|в поиске|срочно|на работу|"
    r"қажет|керек|шақырамыз"
)
# Офисные и руководящие позиции: если такая должность названа раньше рабочей, пост не наш
WHITE_COLLAR = re.compile(
    r"директор|руководител|супервайзер|специалист по|инженер|разработчик|программист|developer|"
    r"маркетолог|marketing|smm|дизайнер|аналитик|бухгалтер|юрист|рекрутер|hr[- ]менеджер|"
    r"педагог|учител|воспитател|врач|медсестр|преподавател|эксперт|consultant"
)
# Вакансии за пределами Казахстана
FOREIGN = re.compile(
    r"ташкент(?!ск)|узбекистан|бишкек|кыргызстан|москв|санкт-петербург|россии\b|\bрф\b|"
    r"турци|анкар|стамбул|ереван|армени|ямал|новомосковск"
)
# Работа точно за границей, даже если в тексте есть казахстанский город (например, город выезда)
ABROAD = re.compile(r"вахт\w*?\s*(?:в\s+)?росси|российская федерация")
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
    ("Бонусы", r"бонус|преми(?:я|и|ю|ей|ями)\b|kpi"),
]
_PERKS = [(name, re.compile(p)) for name, p in PERKS]
_FOR_STUDENTS = re.compile(r"(?<!не )студент")
_NO_STUDENTS = re.compile(r"студент\w*[^.\n]{0,40}не (?:беспоко|рассматрива|подход|бер)|(?:без|кроме) студент")

_NUM = r"\d{1,3}(?:[   .,]\d{3})+|\d+"
_MULT = r"\s*(?:к|k|тыс\.?|тысяч[аи]?)(?![а-яa-z])"
SALARY = re.compile(
    rf"(?P<a>{_NUM})(?P<am>{_MULT})?"
    rf"(?:\s*(?:-|–|—|до)\s*(?P<b>{_NUM})(?P<bm>{_MULT})?)?"
    r"(?=(?P<tail>[^\n]{0,30}))"
)
_CURRENCY = re.compile(r"^\s*(тг|тенге|₸|kzt|tg)", re.I)
_MONEY_CONTEXT = re.compile(r"зп|з/п|зарплат|оклад|оплат|доход|ставк|платим|выплат|смен")
_NOT_MONEY_TAIL = re.compile(r"^\s*(лет|год|:\d|/\s*\d|%|шт|кг|м\b|км|мин|чел|ч\b|час(а|ов)\b|\$|usd|руб|€|eur|долл)")
_FOREIGN_CURRENCY_HEAD = re.compile(r"(\$|usd|€|руб\.?)\s*$")
_LIMITS = {"hour": (300, 15_000), "day": (2_000, 150_000), "month": (40_000, 5_000_000)}

_SCHEDULE = re.compile(r"(?<![\d/])(\d{1,2})\s*/\s*(\d{1,2})(?![\d/])")
# Обычные сменные графики и вахты. Другие пары («11/4») принимаем только в строке про график,
# иначе это номер дома или корпус в адресе.
COMMON_SCHEDULES = {
    "1/1", "1/2", "1/3", "2/1", "2/2", "3/1", "3/2", "3/3", "4/2", "4/3", "5/1", "5/2", "6/1",
    "7/7", "10/10", "14/7", "14/14", "15/15", "20/10", "21/7", "21/21", "28/28", "30/15", "30/30",
}
_SCHEDULE_LINE = re.compile(r"график|смен|вахт|режим")
_ADDRESS_LINE = re.compile(r"адрес|\bул\b|улиц|\bд\.|\bдом\b|мкр|микрорайон|проспект|пр\.|корпус|офис")
_EMPLOYER_LABEL = re.compile(
    r"(?i:название компании|компания|работодатель|организация)\s*[:\-–—]\s*([^\n]{2,60})"
)
_EMPLOYER_INVITES = re.compile(r"^[^\w\n]*([^\n]{2,40}?)\s+приглашает на работу", re.M)
_EMPLOYER_QUOTED = re.compile(r"[«\"]([^«»\"\n]{2,40})[»\"]")
_EMPLOYER_PLACE = re.compile(
    r"(?i:\b(?:кафе|ресторан\w*|рестопарк\w*|рестобар\w*|кофейн\w*|магазин\w*|бар\w*|сет(ь|и)(?:[ \t]+[а-яё]+){1,3}|компани\w*|супермаркет\w*|"
    r"пекарн\w*|столов\w*|пункт\w* выдачи|салон\w*|отел\w*|гостиниц\w*))[ \t]+"
    r"([A-ZА-ЯЁ][\w&'’.-]*(?:[ \t]+[A-ZА-ЯЁ0-9][\w&'’.-]*){0,2})"
)

# Как в agashka_job_almaty: «💼 Бармен», строкой ниже заведение «DINO FEST», дальше зарплата или город
_EMPLOYER_UNDER_TITLE = re.compile(r"(?m)^[ \t]*💼[ \t]*([^\n]*)\n[ \t]*([«\"A-Za-zА-Яа-яЁё][^\n]{1,60})\n[ \t]*(?:💰|📍)")
# Не заведение: «Ресторан паназиатской кухни» без названия, ФИО индивидуального предпринимателя
_GENERIC_PLACE = re.compile(
    r"(?i:кафе|ресторан|столовая|кофейня|пекарня|магазин|минимаркет|супермаркет|салон|компания|сеть|цех|склад|"
    r"производство|завод|фабрика|офис)\w*(?:[ \t,-]+[а-яё]+)*$"
)
_PERSON = re.compile(r"(?i)\b[а-яё]+(?:ович|евич|овна|евна|улы|ұлы|кызы|қызы)\b")
_LEGAL_PARENS = re.compile(r"\s*\((?:тоо|ип|ооо|ао)\b[^)]*\)", re.I)

_PHONE = re.compile(r"(?:\+?[78][\s(-]*)?\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}")
_LINK = re.compile(r"https?://\S+|t\.me/\S+|wa\.me/\S+|@\w{4,}")
_PROMO_LINE = re.compile(
    r"подпис|разместить ваканси|размещени\w* ваканси|реклам|по вопросам|наш канал|поделись", re.I
)


def _lower(text: str) -> str:
    return text.lower().replace("ё", "е")


# Почему пост не стал вакансией: код причины → подпись для админки
REJECT_REASONS = {
    "not_vacancy": "Резюме или объявление",
    "scam": "Сомнительное: заработок в интернете, МЛМ, за рубеж",
    "no_profession": "Нет рабочей профессии",
    "no_hiring": "Не похоже на вакансию",
    "white_collar": "Офис или руководство",
    "abroad": "Вахта в России",
    "foreign": "Другая страна",
}


def _not_vacancy_reason(text: str, low: str) -> str | None:
    if NOT_VACANCY.search(low):
        return "not_vacancy"
    if SCAM.search(low):
        return "scam"
    if not any(rx.search(low) for rx, _, _ in _PROFESSIONS):
        return "no_profession"
    if not HIRING.search(low) and parse_salary(text)[0] is None:
        return "no_hiring"
    return None


def is_vacancy(text: str) -> bool:
    return _not_vacancy_reason(text, _lower(text)) is None


def _title_hits(low: str) -> list[tuple[int, int, str, str]]:
    """Все совпадения должностей: (позиция, −длина, название, категория), по порядку в тексте."""
    hits = []
    for rx, title, cat in _PROFESSIONS:
        for m in rx.finditer(low):
            hits.append((m.start(), -(m.end() - m.start()), title, cat))
    specific = [h for h in hits if h[2] != GENERIC_TITLE]
    return sorted(specific or hits)  # «Сотрудник» — только когда конкретной должности нет


def detect_titles(text: str) -> list[tuple[str, str]]:
    """Должности в порядке появления в тексте: [(название, категория), ...]."""
    result: list[tuple[str, str]] = []
    covered_until = -1
    for start, neg_len, title, cat in _title_hits(_lower(text)):
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
        if _FOREIGN_CURRENCY_HEAD.search(head):
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


def _line_at(text: str, pos: int) -> str:
    end = text.find("\n", pos)
    return text[text.rfind("\n", 0, pos) + 1: end if end != -1 else len(text)]


def parse_schedule(text: str) -> str | None:
    low = _lower(text)
    parts = []
    for m in _SCHEDULE.finditer(low):
        work, rest = int(m[1]), int(m[2])
        pair = f"{work}/{rest}"
        line = _line_at(low, m.start())
        if pair in COMMON_SCHEDULES and not _ADDRESS_LINE.search(line) or (
            _SCHEDULE_LINE.search(line) and 1 <= work <= 30 and 1 <= rest <= 30
        ):
            parts.append(pair)
            break
    if "вахт" in low:
        parts.append("вахта")
    if re.search(r"ночн\w* смен", low):
        parts.append("ночные смены")
    if "подработ" in low:
        parts.append("подработка")
    return ", ".join(parts) or None


# «Развозки нет», «без питания», «жильё не предоставляем», «развозка жоқ»: условие упомянуто, но его нет
_NEGATED_BEFORE = re.compile(r"\b(?:без|нет|не)\s+(?!только\b)(?:\w+\s+)?$")
_NEGATED_AFTER = re.compile(r"^\w*[\s,:—–-]*(?:нет\b|не\s|отсутству|жо[кқ]\b)")


def _offered(rx: re.Pattern, low: str) -> bool:
    return any(not _NEGATED_BEFORE.search(low[max(0, m.start() - 25):m.start()])
               and not _NEGATED_AFTER.match(low[m.end():m.end() + 30])
               for m in rx.finditer(low))


def parse_perks(text: str) -> list[str]:
    low = _lower(text)
    perks = [name for name, rx in _PERKS if _offered(rx, low)]
    if _FOR_STUDENTS.search(low) and "не студент" not in low and not _NO_STUDENTS.search(low):
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


_NOT_EMPLOYER = re.compile(r"не указан|частн\w* лиц|объявлени|хозяин|^я\b|^требу|^нужн|^срочн|ж[ұу]мыс")


_VERB_TAIL = re.compile(r"(?i)\s+(?:приглашает|ищет|требу|набирает)\w*\b.*$")


def _clean_name(name: str) -> str | None:
    quoted = _EMPLOYER_QUOTED.search(name)
    if quoted:
        name = quoted[1]
    name = _VERB_TAIL.sub("", name)
    name = re.sub(r"[^\w\s&'’.,\-+()]", "", name).strip(" .,-")
    if not 2 <= len(name) <= 40 or _NOT_EMPLOYER.search(_lower(name)):
        return None
    if _lower(name) in _TITLE_NAMES:
        return None  # «Работодатель: Администратор» — это должность, а не компания
    return name


def _employer_under_title(text: str) -> str | None:
    m = _EMPLOYER_UNDER_TITLE.search(text)
    if not m:
        return None
    place = _EMPLOYER_PLACE.search(m[1])  # «💼 Официант в ресторан ЮГ22»: название уже в строке должности
    if place:
        return _VERB_TAIL.sub("", place[2]).strip(" .,") or None
    line = _LEGAL_PARENS.sub("", m[2]).strip()
    inner = _EMPLOYER_PLACE.search(line)  # «Сеть ресторанов Lanzhou», «Кафе PARADISE»
    if inner and inner.start() == 0:
        line = inner[2]
    if _GENERIC_PLACE.match(line) or _PERSON.search(line):
        return None
    return _clean_name(line)


def detect_employer(text: str) -> str | None:
    m = _EMPLOYER_LABEL.search(text)
    if m and (name := _clean_name(m[1])):
        return name
    if name := _employer_under_title(text):
        return name
    m = _EMPLOYER_QUOTED.search(text)
    if m:
        return m[1].strip()
    m = _EMPLOYER_PLACE.search(text)
    if m and (name := _VERB_TAIL.sub("", m[2]).strip(" .,")) and not _NOT_EMPLOYER.search(_lower(name)):
        return name  # но не «в кафе Требуется повар»
    m = _EMPLOYER_INVITES.search(text)
    if m:
        return _clean_name(m[1])
    return None


_ADDRESS_LABEL = re.compile(
    r"(?im)^[^\w\n]*(?:адрес\w*|мекенжай\w*|место работы|локаци\w*)(?:[ \t][^:\n]{1,30})?[ \t]*[:.\-–—][ \t]*(.*)$"
)
_PIN_LINE = re.compile(r"(?m)^[ \t]*📍[ \t]*(.+)$")
_INLINE_LABEL = re.compile(r"(?i)^(?:[^:\d\n]{0,25}?\b(?:место(?: работы)?|мекенжай\w*|район|локаци\w*)\s*:|.{0,40}?по адресу\s*:?)\s*")
_NOT_PLACE = re.compile(r"(?i)график|зарплат|з/п|оплат|опыт|требован|обязанност|точ(?:ек|ки)\b|по (?:всему )?город|ближайш|филиал|@|почт")
_PLACE_WORD = re.compile(
    r"(?i)\d|\bул\b|улиц|проспект|\bпр\b|переул|мкр|микрорайон|\b(?:жк|трц|трк|тц|тд|бц)\b|көше|даңғыл|район|берег|рынок|базар"
)
_CITY_NAMES = "|".join(name for name, _ in CITIES.values()) + "|нур-султан"
_CITY_PREFIX = re.compile(rf"(?i)^(?:(?:г\.\s*|город\s+)(?:{_CITY_NAMES})\b|(?:{_CITY_NAMES})(?=\s*[,(]|\s*$))[\s,]*")
_CITY_SUFFIX = re.compile(rf"(?i),\s*(?:г\.?\s*)?(?:{_CITY_NAMES})\s*$")
_DISTRICT_PREFIX = re.compile(r"^[А-ЯЁ][а-яё]+ский район,\s*(?=\S)")


def _shorten(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip(" ,.;–-")
    return cut + "…"


def detect_address(text: str) -> str | None:
    """Адрес из строки «Адрес: …» или «📍 …», без названия города: город и так известен."""
    m = _ADDRESS_LABEL.search(text)
    if m:
        line = m[1].strip()
        if not line:  # «Адрес:» и сам адрес строкой ниже
            line = next((s.strip() for s in text[m.end():].splitlines() if s.strip()), "")
    else:
        pins = (_INLINE_LABEL.sub("", p[1].strip()) for p in _PIN_LINE.finditer(text))
        line = next((p for p in pins if _PLACE_WORD.search(p) and not _NOT_PLACE.search(p)), "")
    line = re.split(r";|\s/\s", line)[0]
    line = re.sub(r"^[^\w«\"(]+", "", line).strip(" \t.,:")
    line = _CITY_SUFFIX.sub("", _CITY_PREFIX.sub("", line))
    if line.startswith("(") and line.endswith(")"):
        line = line[1:-1].strip()
    line = _DISTRICT_PREFIX.sub("", line).strip(" .,")
    if _NOT_PLACE.search(line) or not _PLACE_WORD.search(line) or not re.search(r"[^\W\d_]{3}", line):
        return None
    return _shorten(line, 70)


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
    return explain(post)[0]


def explain(post: RawPost) -> tuple[Vacancy | None, str | None]:
    """Как parse_post, но вместе с причиной отказа (ключ REJECT_REASONS) для журнала сбора."""
    low = _lower(post.text)
    reason = _not_vacancy_reason(post.text, low)
    if reason:
        return None, reason
    titles = detect_titles(post.text)
    if not titles:
        return None, "no_profession"
    white = WHITE_COLLAR.search(low)
    if white and white.start() < _title_hits(low)[0][0]:
        return None, "white_collar"  # офисная или руководящая позиция названа раньше рабочей
    if ABROAD.search(low):
        return None, "abroad"
    city = detect_city(post.text, post.default_city)
    if FOREIGN.search(low) and city == post.default_city and not any(
        re.search(rx, low) for _, rx in CITIES.values()
    ):
        return None, "foreign"
    title = ", ".join(t for t, _ in titles[:3])
    salary_min, salary_max, period = parse_salary(post.text)
    text = clean_text(post.text)
    return Vacancy(
        id=f"{post.channel.lower()}-{post.post_id}",
        title=title,
        category=titles[0][1],
        city=city,
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
        address=detect_address(text),
    ), None

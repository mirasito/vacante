"""Точки для вакансий без точки: адрес из объявления → точка на карте.

У большинства вакансий hh.kz точку ставит сам hh (vacante.sources.hh). Для остальных (из каналов, от
работодателей и с hh.kz без точки) адрес ищем в Nominatim, геокодере OpenStreetMap. Он бесплатный, а по его
правилам (operations.osmfoundation.org/policies/nominatim) запросы идут не чаще одного в секунду, с понятным
User-Agent, и ответы надо хранить у себя. Поэтому каждый адрес спрашиваем один раз и кладём ответ в кеш
geocode.json в ветке data, ненайденный адрес спрашиваем снова не раньше чем через месяц, а за один прогон сбора
делаем не больше GEOCODE_LIMIT запросов (по умолчанию LIMIT, 0 выключает запросы; разово больше — поле
geocode_limit при ручном запуске «Обновления вакансий»). Данные OpenStreetMap под лицензией ODbL: приложение
пишет «© OpenStreetMap» рядом с расстоянием.

Точный ответ — дом, здание или заведение: рамка найденного не больше 1,5 км по диагонали. Если точно не
нашлось, берём примерную точку: середину найденной улицы, микрорайона или ЖК, если они не больше 5 км. Такая
точка помечена примерной (approx), и приложение пишет «Примерно N км от дома». Точка всегда не дальше 50 км от
центра города вакансии. Адрес без номера дома и без ТЦ, БЦ или ЖК («Есильский район») не ищем: точки у такого
адреса нет.

Nominatim ищет все слова запроса, поэтому адрес из объявления часто не находится целиком: мешают район, этаж
или заведение («Есильский район, ул. Туран, 55, 2 этаж»), «ул.» у проспекта, имя в названии улицы («Турара
Рыскулова» у проспекта Рыскулова) или «мкр» вместо «микрорайон». Тогда спрашиваем запасные запросы
(fallbacks): адрес без лишнего, улицу без «ул.» и имени, улицу без номера дома (точка примерная), торговый
центр по названию. Адрес в другом городе или в селе запасных запросов не получает. Насколько они точны,
показывает `vacante geocheck` на вакансиях hh.kz, где точку поставил сам hh.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import logging
import os
import re
import statistics
import time
from collections.abc import Callable
from datetime import datetime, timedelta
from pathlib import Path

import httpx

from vacante.geo import CENTRES, MAP_WORTHY, city_point, distance_km
from vacante.models import Vacancy
from vacante.parse import CITIES

log = logging.getLogger(__name__)

URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "VacanteBot/1.0 (+https://vacante.kz)"
SOURCE = "osm"
FILE = "geocode.json"
LIMIT = 60  # запросов за прогон сбора: около минуты при паузе в секунду
PAUSE = 1.1  # секунд перед каждым запросом
RETRY_MISS = timedelta(days=30)
KEEP = timedelta(days=60)  # запись кеша, которой давно не пользовались, уходит
MAX_BOX_KM = 1.5  # точный ответ: дом, здание, заведение
APPROX_BOX_KM = 5.0  # примерный: улица, микрорайон, ЖК — точка посередине, расстояние «примерно»
# С версии 2 кеш знает примерные точки, с 3 — запасные запросы: ненайденное прошлыми версиями спрашиваем заново
VERSION = 3
BOX = (0.3, 0.45)  # окно поиска вокруг центра города: ±0,3° широты и ±0,45° долготы, около 35 км
RETRY_AFTER = 5.0  # секунд до повтора запроса, на который Nominatim не ответил (таймаут, обрыв, 5xx)
MAX_FAILURES = 3  # столько адресов подряд без ответа и после повтора: Nominatim нездоров, хватит на этот прогон
RESULTS = 5  # ответов на запасной запрос: если подходящие в разных концах города, адрес не понять
_PARENS = re.compile(r"\s*\([^)]*\)?|…")
_SPACES = re.compile(r"\s+")

# Запасные запросы. Сначала чиним написание: кавычки, «ул.Абая», «12мкр», «16-мкр», «71-үй»
_QUOTES = re.compile(r"[«»\"“”„]")
_DOTTED = re.compile(r"(?i)(?<![\w-])(ул|пр|мкр|мкрн|пер|просп|[^\W\d_])\.(?=[^\W\d_])")  # и «Ж.Жабаева»
_GLUED = re.compile(r"(?i)(\d)([а-яёәғқңөұүһі]{3,})")
_HYPHEN = re.compile(r"(?i)(\d)-(?=(?:мкр|мкрн|микрорайон|шағын|ықшам|үй|ғимарат)(?![\w-]))")
_LABEL = re.compile(r"(?i)^\W*(?:местоположение|локация|адрес|адресі|мекен-?жай[ы]?|жұмыс\s+орны|орналасқан\s+жері)"
                    r"(?![\w-])\W*")
_MKR = re.compile(r"(?i)(?<![\w-])(?:мкр|мкрн|мик-н|м-н|м-он|микр|микрорайон|шағын\s*аудан[ы]?|ш\.\s*а|ш\s*/\s*а|"
                  r"ықшам\s*аудан[ы]?)(?![\w-])\.?")
_STREET = re.compile(r"(?i)(?<![\w-])(?:ул|улица|көшесі|көш|пр|пр-т|просп|проспект|даңғылы|даң|бульвар[ы]?|б-р|"
                     r"шоссе|тас\s*жолы|переулок|пер|тупик|тұйығы|проезд|тракт|трасса|набережная|площадь|алаңы|"
                     r"аллея)(?![\w-])\.?")
_DISTRICT = re.compile(r"(?i)(?<![\w-])(?:район[а-я]*|аудан[ы]?|берег|жағалау[ы]?)(?![\w-])")
# Село, посёлок или «75 км от Астаны»: работа за городом, улицу с тем же названием в городе брать нельзя
_SETTLEMENT = re.compile(r"(?i)(?<![\w-])(?:село|селосы|с\.|пос[её]лок|п\.|пгт|аул|ауыл[ы]?|станция|ст\.|км|"
                         r"област[ьи]|облысы?)(?![\w-])")
_MALL = re.compile(r"(?i)(?<![\w-])(?:трц|трк|тц|тд|тк|бц|торговый\s+(?:дом|центр|комплекс)|бизнес-?\s*центр|"
                   r"сауда\s+(?:орталығы|үйі))(?![\w-])")
# Часть адреса, которая только мешает: этаж, заведение, ориентир
_NOISE = re.compile(r"(?i)этаж|қабат|бутик|офис|кабинет|павильон|блок|блогы|секци|контейнер|подъезд|вход|крыло|"
                    r"кафе|ресторан|столов|магазин|дүкен|аптек|гостиниц|салон|барбершоп|мойк|азс|заправк|база|"
                    r"склад|рын[оке]|базар|маркет|остановк|метро|центр(?!альн)|орталығ|напротив|возле|около|рядом|"
                    r"угол|школ|гимнази|мектеп|балабақш|садик|жұмыс|кестес|график|телефон|зарплат|оклад|"
                    r"(?<![\w-])(?:жк|за|уг|тел)(?![\w-])")
_NUM = r"\d+[а-яёa-z]?(?:[/\\]\d+[а-яёa-z]?)?"
_MARKED = re.compile(rf"(?i)(?<![\w-])(?:дом|д\.|здание|зд\.|№)\s*№?\s*({_NUM})(?![\w/\\])")
_HOUSE_PART = re.compile(r"(?i)(?:(?:дом|д\.|здание|зд\.|№)\s*)?№?\s*(\d+(?:\s?[а-яёa-z])?(?:[/\\]\d+[а-яёa-z]?)?)"
                         r"(?:\s*(?:дом|үй|ғимарат))?")
_INITIAL = re.compile(r"(?i)[^\W\d_]\.")  # «Ж.» в «ул. Ж. Жабаева»
_SURNAME = re.compile(r"(?i)[^\W\d_]{2,}(?:ова|ева|ёва|ина|ына|улы|ұлы)$")  # «Рыскулова», но не «улы» в «Момыш улы»
_TITLES = {"батыра", "батыр", "хана", "хан", "хандар", "би", "ата", "ана", "акына", "ақын", "абыз", "баба"}
# Торговый или бизнес-центр по названию: берём только сам центр, а не кафе или школу с тем же именем
_MALL_KINDS = {("shop", "mall"), ("shop", "department_store"), ("shop", "supermarket"), ("amenity", "marketplace"),
               ("building", "retail"), ("building", "commercial"), ("building", "office"), ("landuse", "retail"),
               ("landuse", "commercial")}


class Stop(Exception):
    """Nominatim просит подождать или закрыл доступ (429, 403): остальные адреса в следующий прогон."""


class Skip(Exception):
    """Nominatim не ответил на этот адрес и после повтора: спросим его в следующий прогон."""


def query(v: Vacancy) -> str | None:
    """Строка поиска «адрес, город» или None, если искать нечего (в том числе точка уже есть)."""
    if v.lat is not None or not v.address or v.city not in CENTRES:
        return None
    name = CITIES[v.city][0]
    # Город в начале («г. Алматы, …», «Алматы қаласы, …») не нужен: он и так в конце запроса
    lead = re.compile(rf"(?i)^(?:(?:г\.?\s*|город\s+)?{re.escape(name)}\b)?(?:\s*қаласы\b)?[\s,.;]*")
    address = lead.sub("", _PARENS.sub("", v.address).strip(" ,.;"), count=1)
    if not MAP_WORTHY.search(address):
        return None
    return _SPACES.sub(" ", f"{address}, {name}")


def _parts(address: str) -> list[str]:
    """Части адреса через запятую, с починенным написанием: «ул.Абая» → «ул. Абая», «12мкр» → «12 мкр»."""
    text = _QUOTES.sub("", address)
    text = _DOTTED.sub(r"\1. ", text)
    text = _GLUED.sub(r"\1 \2", text)
    text = _HYPHEN.sub(r"\1 ", text)
    text = _LABEL.sub("", text.strip())
    parts = (_SPACES.sub(" ", x).strip(" .:-–—") for x in re.split(r"[,;]", text))
    return [p for p in (re.sub(r"(?i)^(?:в|на|по)\s+", "", x) for x in parts) if p]  # «в 4 мкр»


_KAZAKH = str.maketrans("әғқңөұүһі", "агкноуухи")


def _is_city(part: str, rx: str) -> bool:
    """«Алматы», «г. Астана», «Нур-Султан», «Ақтау қаласы»: rx — корни названий из parse.CITIES."""
    plain = part.lower().translate(_KAZAKH)
    return re.fullmatch(rf"(?:г\.?\s*|город\s+)?(?:{rx})[а-яё]{{0,3}}(?:\s+каласы)?", plain) is not None


def _is_name(part: str) -> bool:
    """Похоже на название улицы без слова «улица»: только буквы, до четырёх слов («Курмангазы», «Султан Бейбарыс»)."""
    return (re.fullmatch(r"[^\W\d_](?:[^\W\d_]|[ .'’-])*", part) is not None and len(part.split(" ")) <= 4
            and re.search(r"[^\W\d_]{3}", part) is not None)


def _house(part: str) -> str | None:
    """Номер дома, если вся часть адреса — номер: «40», «дом 47», «85 үй», «здание №48»."""
    m = _HOUSE_PART.fullmatch(part)
    return _SPACES.sub("", m.group(1)) if m else None


def _split_house(part: str) -> tuple[str, str | None]:
    """Улица и номер дома из одной части: «Абая 150 офис 3» → («Абая», «150»), «мкр Самал 2 д. 111» →
    («мкр Самал 2», «111»). Без номера — (part, None); всё после номера отбрасываем."""
    if (m := _MARKED.search(part)) and re.search(r"[^\W\d_]{2}", part[:m.start()]):
        return part[:m.start()].strip(" .-"), m.group(1)
    words = part.split(" ")
    for i in range(1, len(words)):
        number = words[i].strip(".:;")
        if not re.fullmatch(rf"(?i){_NUM}", number):
            continue
        head = " ".join(words[:i])
        if re.fullmatch(r"[^\W\d_]-?", words[i - 1]):
            continue  # «ул. Е 899»: номер — часть названия улицы
        if re.search(rf"{_MKR.pattern}\s*$", head) and not re.search(r"\d", head):
            continue  # «микрорайон 8»: номер — имя микрорайона
        if re.search(r"[^\W\d_]{2}", head):
            return head.strip(" .-"), number
    return part, None


def _clean(q: str, city: str) -> tuple[list[str], str | None, str | None] | None:
    """Адрес без лишнего: (микрорайон и улица, номер дома, торговый центр, если больше ничего нет).

    None, если запасным запросам тут нечего делать: в адресе другой город или село, или перед улицей
    непонятное место («Талгар, ул. Райымбека»), и улица с тем же названием в городе может оказаться не той."""
    own = CITIES[city][1]
    others = [rx for slug, (_, rx) in CITIES.items() if slug != city]
    places: list[str] = []
    street = house = mall = pending = None
    for part in _parts(q.rpartition(", ")[0]):
        if house is not None:
            break  # после номера дома — ориентиры, этажи и заведения
        if _SETTLEMENT.search(part):
            return None
        mkr, typed = _MKR.search(part), _STREET.search(part)
        if mkr is None and typed is None:
            if _is_city(part, own):
                continue
            if any(_is_city(part, rx) for rx in others):
                return None
            if (number := _house(part)) is not None:
                if street is None and pending is not None:
                    street, pending = pending, None  # «Курмангазы, 76»
                if street is not None or places:
                    house = number
            elif _DISTRICT.search(part):
                continue
            elif _MALL.search(part):
                mall = part if mall is None else ""  # два центра в адресе: непонятно, какой
            elif _NOISE.search(part):
                continue
            elif (split := _split_house(part))[1] is not None and _is_name(split[0]):
                if street is None and pending is None:
                    street, house = split  # «Шавтрова 11»
            elif _is_name(part) and street is None and not places:
                if pending is not None:
                    return None
                pending = part
            continue
        if pending is not None:
            return None
        if mkr is not None and (typed is None or mkr.start() < typed.start()):
            # Микрорайон и улица в одной части: «мкр. Коянкус ул. Момыш улы 200» (название после «мкр») или
            # «Бағанашыл шағын ауданы Подгорная көшесі» (название перед ним)
            cut = len(part) if typed is None else typed.start() if mkr.start() == 0 else mkr.end()
            head, number = _split_house(part[:cut])
            places.append(_SPACES.sub(" ", _MKR.sub(" микрорайон ", head)).strip(" .-"))
            if number is not None or typed is None:
                house = number
                continue
            part = part[cut:].strip()
            typed = _STREET.search(part)
        if street is not None or typed is None:
            continue  # вторая улица («угол Абая и Сейфуллина»): берём первую
        if typed.start() and (_MALL.search(part[:typed.start()]) or _NOISE.search(part[:typed.start()])):
            part = part[typed.start():]  # «ЖК Тау Шатыр ул. Каппарова 6» → «ул. Каппарова 6»
        street, house = _split_house(part)
    if street is not None:
        places.append(street)
    if not places:  # торговый центр, если кроме него в адресе нет других названий («ТРЦ Forum, Mega»)
        return ([], None, mall) if mall and pending is None else None
    return places, house, None


def _bare(street: str) -> str:
    """Улица без «ул.», «проспект», инициалов и имени: «проспект Турара Рыскулова» → «Рыскулова»,
    «ул. Ж. Жабаева» → «Жабаева». «Кабанбай батыра» и «7-я улица» остаются как есть."""
    words = [w for w in _SPACES.sub(" ", _STREET.sub(" ", street)).strip(" .-").split(" ")
             if w and not _INITIAL.fullmatch(w)]
    if not re.search(r"[^\W\d_]{3}", " ".join(words)):
        return street
    if len(words) >= 2 and _SURNAME.search(words[-1]) and words[-1].lower() not in _TITLES:
        words = words[-1:]
    return " ".join(words)


def _key(text: str) -> str:
    return re.sub(r"[\W_]+", " ", text.lower()).strip()


def fallbacks(q: str, city: str) -> list[tuple[str, str, str | None]]:
    """Запасные запросы, если адрес целиком не нашёлся: (шаг, запрос, слой Nominatim).

    clean — адрес без района, этажа и заведения; bare — улица без «ул.» и имени, и только среди адресов
    (layer=address), чтобы вместо проспекта Туран не найти кафе «Туран»; street — улица или микрорайон без
    номера дома, точка всегда примерная; mall — торговый или бизнес-центр по названию."""
    cleaned = _clean(q, city) if city in CITIES else None
    if cleaned is None:
        return []
    places, house, mall = cleaned
    name = q.rpartition(", ")[2]
    steps: list[tuple[str, str, str | None]] = []
    seen = {_key(q)}

    def add(step: str, words: list[str], layer: str | None) -> None:
        text = ", ".join([*words, name])
        if _key(text) not in seen and re.search(r"[^\W\d_]", ", ".join(words)):  # не одни цифры
            seen.add(_key(text))
            steps.append((step, text, layer))

    if mall:
        add("mall", [_SPACES.sub(" ", _MALL.sub(" ", mall)).strip(" .-")], None)
        return steps
    bare = [p if "микрорайон" in p else _bare(p) for p in places]
    if house is not None:
        add("clean", [*places, house], None)
        add("bare", [*bare, house], "address")
    # Микрорайон бывает и местом, и жилым кварталом (landuse), а улицу ищем только среди адресов
    add("street", bare, None if all("микрорайон" in p for p in places) else "address")
    return steps


def load(data_dir: Path) -> dict[str, dict]:
    path = data_dir / FILE
    return json.loads(path.read_text("utf-8")) if path.exists() else {}


def save(data_dir: Path, cache: dict[str, dict]) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(dict(sorted(cache.items())), ensure_ascii=False, indent=0)
    (data_dir / FILE).write_text(payload + "\n", "utf-8")


def search(client: httpx.Client, q: str, city: str, sleep: Callable[[float], None] = time.sleep, *,
           layer: str | None = None, limit: int = 1, stats: dict | None = None) -> list[dict]:
    """Ответы Nominatim, лучший первым; пустой список, если он ничего не нашёл. stats["requests"] считает запросы.

    Таймаут, обрыв или сбой сервера повторяем один раз, а не вышло — Skip: адрес спросим в следующий прогон.
    429 и 403 — Stop: дальше в этот прогон не спрашивать."""
    lat0, lon0 = CENTRES[city]
    dlat, dlon = BOX
    params = {"q": q, "format": "jsonv2", "limit": limit, "countrycodes": "kz", "accept-language": "ru",
              "viewbox": f"{lon0 - dlon},{lat0 + dlat},{lon0 + dlon},{lat0 - dlat}", "bounded": 1}
    if layer:
        params["layer"] = layer
    failure = ""
    for wait in (PAUSE, RETRY_AFTER):
        sleep(wait)
        if stats is not None:
            stats["requests"] = stats.get("requests", 0) + 1
        try:
            r = client.get(URL, params=params)
        except httpx.HTTPError as exc:
            failure = type(exc).__name__
            continue
        if r.status_code in (403, 429):
            raise Stop(f"HTTP {r.status_code}")
        if r.status_code >= 500:
            failure = f"HTTP {r.status_code}"
            continue
        if r.status_code != 200:
            return []  # запрос Nominatim не понял (400 и т.п.): так адрес не найти
        try:
            found = r.json()
        except ValueError:
            failure = "ответ не JSON"
            continue
        break
    else:
        raise Skip(failure)
    return [r for r in found if isinstance(r, dict)] if isinstance(found, list) else []


def place_point(found: dict, city: str) -> tuple[tuple[float, float], bool] | None:
    """Точка ответа Nominatim и примерная ли она, или None, если ответ слишком размытый или не в городе.

    Точка Nominatim — середина найденного места: у дома сам дом, у улицы её середина, у микрорайона центр."""
    try:
        lat, lon = float(found["lat"]), float(found["lon"])
        south, north, west, east = (float(x) for x in found["boundingbox"])
    except (KeyError, TypeError, ValueError):
        return None
    box = distance_km((south, west), (north, east))
    if box > APPROX_BOX_KM:
        return None  # длинная улица, район или весь город: где работа, не понять даже примерно
    point = city_point(city, lat, lon)
    return (point, box > MAX_BOX_KM) if point else None


def pick(found: list[dict], city: str, mall: bool = False) -> tuple[tuple[float, float], bool] | None:
    """Точка первого подходящего ответа и примерная ли она. None, если подходящих нет или они в разных концах
    города («Туран, 5» — и проспект, и улица в пригороде): тогда не понять, какой из них в объявлении."""
    points = [p for r in found
              if (not mall or (r.get("category"), r.get("type")) in _MALL_KINDS or r.get("category") == "office")
              and (p := place_point(r, city)) is not None]
    if not points or any(distance_km(points[0][0], p[0]) > APPROX_BOX_KM for p in points[1:]):
        return None
    return points[0]


def lookup(client: httpx.Client, q: str, city: str, sleep: Callable[[float], None] = time.sleep,
           stats: dict | None = None) -> tuple[tuple[float, float], bool, str] | None:
    """Точка адреса, примерная ли она и каким запасным запросом нашлась ("" — самим адресом), или None.

    Точка улицы или микрорайона без номера дома (шаг street) всегда примерная."""
    if (point := pick(search(client, q, city, sleep, stats=stats), city)) is not None:
        return point[0], point[1], ""
    for step, text, layer in fallbacks(q, city):
        found = search(client, text, city, sleep, layer=layer, limit=RESULTS, stats=stats)
        if (point := pick(found, city, mall=step == "mall")) is not None:
            return point[0], point[1] or step == "street", step
    return None


def limit_from_env() -> int:
    try:
        return max(0, int(os.environ.get("GEOCODE_LIMIT", LIMIT)))
    except ValueError:
        return LIMIT


def locate(vacancies: list[Vacancy], data_dir: Path, now: datetime, client: httpx.Client | None = None,
           sleep: Callable[[float], None] = time.sleep, limit: int | None = None) -> dict:
    """Ставит точки вакансиям без точки: из кеша, а новые адреса ищет, свежие вакансии первыми."""
    limit = limit_from_env() if limit is None else limit
    cache = load(data_dir)
    today = now.date().isoformat()
    retry_before = (now - RETRY_MISS).date().isoformat()
    wanted: dict[str, tuple[str, str, list[Vacancy]]] = {}
    for v in vacancies:
        if (q := query(v)) is not None:
            wanted.setdefault(q.lower(), (q, v.city or "", []))[2].append(v)
    order = sorted(wanted, key=lambda k: max(v.posted_at for v in wanted[k][2]), reverse=True)
    stats = {"addresses": len(wanted), "cached": 0, "asked": 0, "requests": 0, "found": 0, "approx": 0, "failed": 0}
    own = client is None and limit > 0
    if own:
        client = httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=20)
    stopped = None
    failures = 0  # адресов подряд без ответа
    try:
        for key in order:
            q, city, items = wanted[key]
            entry = cache.get(key)
            if entry is not None and (entry.get("p") is not None
                                      or (entry.get("v") == VERSION and entry.get("at", "") >= retry_before)):
                stats["cached"] += 1
            elif client is not None and stopped is None and stats["requests"] < limit:
                try:
                    result = lookup(client, q, city, sleep, stats)
                except Skip as exc:
                    stats["failed"] += 1
                    failures += 1
                    if failures >= MAX_FAILURES:
                        stopped = f"{exc} у {failures} адресов подряд"
                    continue
                except Stop as exc:
                    stopped = str(exc)
                    continue
                failures = 0
                stats["asked"] += 1
                entry = cache[key] = {"p": list(result[0]) if result else None, "at": today, "v": VERSION}
                if result and result[1]:
                    entry["a"] = True  # примерная точка
                if result and result[2]:
                    entry["by"] = result[2]  # каким запасным запросом нашлась
            else:
                continue
            entry["used"] = today
            if entry.get("p"):
                stats["found"] += 1
                stats["approx"] += bool(entry.get("a"))
                for v in items:
                    v.lat, v.lon = entry["p"]
                    v.geo = SOURCE
                    v.approx = bool(entry.get("a"))
    finally:
        if own and client is not None:
            client.close()
    keep_after = (now - KEEP).date().isoformat()
    cache = {k: e for k, e in cache.items() if e.get("used", e.get("at", "")) >= keep_after}
    save(data_dir, cache)
    if stopped:
        stats["stopped"] = stopped
        log.warning("геокодер: Nominatim ответил %s, остальные адреса в следующий прогон", stopped)
    log.info("геокодер: %s", summary(stats))
    return stats


def summary(stats: dict) -> str:
    text = (f"адресов {stats['addresses']}, из кеша {stats['cached']}, спрошено {stats['asked']} "
            f"(запросов {stats.get('requests', stats['asked'])}), с точкой {stats['found']} "
            f"(примерной {stats['approx']}), без ответа {stats['failed']}")
    return text + (f"; остановлен: {stats['stopped']}" if stats.get("stopped") else "")


STEPS = {"": "адрес целиком", "clean": "без лишнего", "bare": "без «ул.» и имени", "street": "улица без дома",
         "mall": "торговый центр"}


def check(vacancies: list[Vacancy], sample: int, client: httpx.Client | None = None,
          sleep: Callable[[float], None] = time.sleep) -> dict:
    """Насколько точен поиск: на вакансиях hh.kz, где точку поставил сам hh, спрашиваем адрес и каждый запасной
    запрос отдельно и меряем, далеко ли найденная точка от точки hh. Кеш не трогаем.

    Берём sample адресов, у которых есть запасные запросы, всегда одних и тех же (по хешу адреса)."""
    picked: dict[str, tuple[str, str, tuple[float, float]]] = {}
    for v in vacancies:
        if v.geo == "hh" and v.lat is not None and v.lon is not None and v.city:
            q = query(dataclasses.replace(v, lat=None, lon=None))
            if q is not None and fallbacks(q, v.city):
                picked.setdefault(q.lower(), (q, v.city, (v.lat, v.lon)))
    keys = sorted(picked, key=lambda k: hashlib.sha256(k.encode()).hexdigest())[:max(0, sample)]
    result: dict = {"addresses": 0, "requests": 0, "steps": {}, "ladder": [], "worst": [], "stopped": None}
    own = client is None and bool(keys)
    if own:
        client = httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=20)
    failures = 0
    try:
        for key in keys:
            q, city, truth = picked[key]
            tries: list[tuple[str, str, str | None]] = [("", q, None), *fallbacks(q, city)]
            outcome: dict[str, tuple[float, bool] | None] = {}
            try:
                for step, text, layer in tries:
                    found = search(client, text, city, sleep, layer=layer, limit=RESULTS if step else 1,
                                   stats=result)
                    point = pick(found, city, mall=step == "mall")
                    outcome[step] = (distance_km(point[0], truth), point[1] or step == "street") if point else None
            except Skip as exc:
                failures += 1
                if failures >= MAX_FAILURES:
                    result["stopped"] = f"{exc} у {failures} адресов подряд"
                    break
                continue
            except Stop as exc:
                result["stopped"] = str(exc)
                break
            failures = 0
            result["addresses"] += 1
            for step, got in outcome.items():
                result["steps"].setdefault(step, []).append(got)
                if got is not None and got[0] > 3:
                    result["worst"].append((round(got[0], 1), step, q))
            first = next((got for step, _, _ in tries if (got := outcome.get(step)) is not None), None)
            result["ladder"].append(first)
    finally:
        if own and client is not None:
            client.close()
    result["worst"] = sorted(result["worst"], reverse=True)[:8]
    return result


def check_report(result: dict) -> list[str]:
    """Строки отчёта check: по каждому запросу, сколько нашлось и насколько точно."""

    def line(label: str, got: list) -> str:
        errors = sorted(g[0] for g in got if g is not None)
        approx = sum(1 for g in got if g is not None and g[1])
        text = f"{label}: спрошено {len(got)}, нашлось {len(errors)} (примерных {approx})"
        if errors:
            near = sum(1 for e in errors if e <= 1)
            text += (f"; от точки hh: медиана {statistics.median(errors):.1f} км, до 1 км {near * 100 // len(errors)}%,"
                     f" дальше 3 км {sum(1 for e in errors if e > 3)}")
        return text

    lines = [f"адресов {result['addresses']}, запросов {result['requests']}"
             + (f"; остановлен: {result['stopped']}" if result["stopped"] else "")]
    lines += [line(STEPS.get(step, step), got) for step, got in result["steps"].items()]
    lines.append(line("по цепочке, как в сборе", result["ladder"]))
    lines += [f"{err} км · {STEPS.get(step, step)} · {q}" for err, step, q in result["worst"]]
    return lines

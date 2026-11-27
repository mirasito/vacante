"""Статический сайт-каталог из data/vacancies.json.

Страницы: главная, город, город + сфера (для поиска «работа официантом Алматы»),
карточка вакансии, sitemap.xml и robots.txt. Плюс админка /admin/ для владельца (см. site/admin.py).
"""

from __future__ import annotations

import html
import json
import re
import shutil
import tomllib
import zlib
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote, urlparse

from jinja2 import Environment, FileSystemLoader, select_autoescape

from vacante import channels, closed, launch, shifts
from vacante import venues as venue_store
from vacante.direct import BOT_USERNAME, FORM_URL, POST_URL
from vacante.geo import MAP_WORTHY
from vacante.localtime import LOCAL
from vacante.models import Vacancy
from vacante.parse import CATEGORIES, CITIES
from vacante.site import appfeed, i18n
from vacante.site.admin import admin_data, seal
from vacante.store import MAX_AGE_DAYS, load_vacancies

HERE = Path(__file__).parent
# Для фильтра «Зарплата от …»: смены и часы пересчитываем в полный месяц.
PER_MONTH = {"month": 1, "day": 22, "hour": 176}
# Условия, по которым можно отфильтровать список; «С зарплатой» проверяется отдельно.
FILTER_PERKS = ["Без опыта", "Питание", "Развозка", "Жильё", "Ежедневная оплата", "Можно студентам", "Официально", shifts.SHIFT]


def employer_prices(wrangler: Path = HERE.parents[1] / "bot" / "wrangler.toml") -> dict | None:
    """Тарифы для страницы «Работодателям» из настроек бота (bot/wrangler.toml), чтобы цены были в одном месте."""
    try:
        env = tomllib.loads(wrangler.read_text("utf-8")).get("vars", {})
        packs = [dict(zip(("count", "price", "days"), map(int, p.strip().split(":"))))
                 for p in str(env.get("PACKS", "")).split(",") if p.strip()]
        return {"post": int(env["POST_PRICE"]), "pro": int(env["BOOST_PRICE"]), "days": int(env["BOOST_DAYS"]),
                "shift_pro": int(env["SHIFT_BOOST_PRICE"]), "packs": packs,
                "instagram": str(env.get("INSTAGRAM", "")).strip()}
    except (OSError, KeyError, ValueError, tomllib.TOMLDecodeError):
        return None


def telegram_channels(data_dir: Path) -> dict[str, str]:
    """Работающие свои каналы vacante по городам: кнопка подписки на страницах города."""
    return {city: f"https://t.me/{chat.lstrip('@')}" for city, chat in channels.live(data_dir).items()}

# Ссылки «Ещё вакансии» на поиск hh.kz и рубрику «Работа» OLX: переход на их сайт ко всем вакансиям города
# (часть вакансий hh и OLX мы и сами собираем: vacante/sources/hh.py и olx.py).
# Коды городов hh из справочника api.hh.ru/areas/40, адреса городов OLX из olx.kz/sitemap-locations.xml;
# для остальных городов ссылка ведёт на весь Казахстан.
HH_AREAS = {"almaty": 160, "astana": 159, "aktobe": 154, "atyrau": 153, "semey": 185, "ust-kamenogorsk": 194,
            "taraz": 187}
OLX_CITIES = {"astana": "astana", "atyrau": "atyrau", "aktau": "aktau_5633", "kostanay": "kostanay",
              "petropavlovsk": "petropavlovsk"}
# Запрос в поиск hh.kz для сферы (синтаксис hh: OR между словами)
HH_QUERIES = {"horeca": "официант OR повар OR бармен OR бариста", "retail": "продавец OR кассир",
              "warehouse": "кладовщик OR грузчик OR комплектовщик", "delivery": "курьер OR водитель",
              "service": "уборщица OR горничная OR мойщик", "construction": "разнорабочий OR строитель",
              "callcenter": "оператор колл-центра"}
FEED_SIZE = 300
# Сколько карточек в самой странице списка. Остальные лежат рядом в cards.json и подгружаются,
# когда человек ищет, фильтрует или жмёт «Показать ещё»: страница города с тысячами карточек
# весила мегабайты, телефон её долго открывал, а Google не дочитывал.
PAGE_SIZE = 50
# Страница профессии в городе («Официант: вакансии в Алматы») появляется от стольких вакансий
PROFESSION_MIN = 3
# Слишком общие названия, по ним страницу не делаем
PROFESSION_SKIP = {"Сотрудник", "Рабочий", "Оператор"}
# Похожих вакансий внизу страницы вакансии
SIMILAR = 6
# Текст объявления без работодателя, с которого оно идёт в Google Jobs как «confidential» (job_posting_ld)
CONFIDENTIAL_TEXT = 200
# Ключ IndexNow: публичный, лежит файлом в корне сайта (vacante/indexnow.py)
INDEXNOW_KEY = "5f0c2a7e9b3d4c18a6e1f7d2b9c4a3e8"
# Сколько первых символов текста объявления попадает в поиск на странице списка: страница
# содержит все вакансии города, и полный текст каждой сделал бы её слишком тяжёлой для телефона.
SEARCH_TEXT = 300
# Подтверждение сайта в Google Search Console и Яндекс Вебмастере (метатеги) и счётчик
# Яндекс Метрики. Значения публичные, они всё равно видны в коде страницы.
SITE_TAGS = {"google_verification": "GQjMSgo5pc-ADt2n0s-GBlVU9kMnuA9jWIZo2WQAejA",
             "yandex_verification": "5e4790f22ea3db3f", "metrika_id": "113822258"}
_MAP_WORTHY = MAP_WORTHY


def money(value: int) -> str:
    return f"{value:,}".replace(",", " ")


def _range(lo: int | None, hi: int | None, unit: str, lang: str) -> str:
    """«от 200 000 ₸/мес» по-русски, «200 000 ₸/ай бастап» по-казахски."""
    if lo is not None and lo == hi:
        return f"{money(lo)} {unit}"  # hh пишет «19 000 – 19 000»
    if lo is not None and hi is not None:
        return f"{money(lo)} – {money(hi)} {unit}"
    if lang == "kk":
        return f"{money(lo)} {unit} бастап" if lo is not None else f"{money(hi)} {unit} дейін"
    return f"от {money(lo)} {unit}" if lo is not None else f"до {money(hi)} {unit}"


def salary_label(v: Vacancy, lang: str = "ru") -> str | None:
    if v.salary_min is None and v.salary_max is None:
        return None
    return _range(v.salary_min, v.salary_max, f"₸/{i18n.PERIOD[lang][v.salary_period]}", lang)


def monthly_pay(v: Vacancy) -> int | None:
    top = v.salary_max or v.salary_min
    return top * PER_MONTH[v.salary_period] if top else None


def monthly_label(v: Vacancy, lang: str = "ru") -> str | None:
    """Оплата за смену или час в пересчёте на месяц, чтобы сравнивать с месячными: «≈ 264 000 ₸/мес»."""
    if v.salary_period in (None, "month") or (v.salary_min is None and v.salary_max is None):
        return None
    k = PER_MONTH[v.salary_period]
    lo = v.salary_min * k if v.salary_min is not None else None
    hi = v.salary_max * k if v.salary_max is not None else None
    return "≈ " + _range(lo, hi, f"₸/{i18n.PERIOD[lang]['month']}", lang)


def search_text(v: Vacancy, lang: str = "ru") -> str:
    """По чему ищет строка поиска на странице списка: должность, заведение, условия и начало текста.
    На казахской версии ещё казахское название и условия: ищут и «даяшы», и «официант»."""
    extra = [i18n.title(v, lang), " ".join(i18n.perk(p, lang) for p in v.perks)] if lang == "kk" else []
    parts = [v.title, *extra, v.employer or "", v.schedule or "", v.address or "", " ".join(v.perks),
             v.text[:SEARCH_TEXT]]
    return " ".join(parts).lower()


def plural(n: int, one: str, few: str, many: str, lang: str = "ru") -> str:
    if lang == "kk":
        return i18n.UI.get(one, one)  # по-казахски после числа единственное число: «5 вакансия»
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def twogis_url(v: Vacancy) -> str | None:
    """Поиск адреса в 2ГИС, чтобы сразу понять, где это. Только для адресов с домом или ТЦ."""
    city = venue_store.TWOGIS_CITIES.get(v.city or "")
    if not city or not v.address or not _MAP_WORTHY.search(v.address):
        return None
    query = re.sub(r"\s*\([^)]*\)?|…", "", v.address).strip(" ,")
    return f"https://2gis.kz/{city}/search/{quote(query)}"


def bot_item(v: Vacancy, base_url: str, campaign: str) -> str:
    """Вакансия в подборке бота (HTML-разметка Telegram). Её же бот берёт из feed.json для первых примеров.
    campaign — в каком сообщении она стоит (launch.utm): sub, morning или examples."""
    e = html.escape
    page = launch.utm(f"{base_url}/v/{v.id}/", "bot", campaign, v.city)
    lines = [f'<b><a href="{e(page)}">{e(v.title)}</a></b>' + (f" · {e(v.employer)}" if v.employer else "")]
    facts = [f"💰 {e(s)}" for s in [salary_label(v)] if s] + ([f"🕒 {e(v.schedule)}"] if v.schedule else [])
    if facts:
        lines.append(" · ".join(facts))
    lines.append(f"📍 {e(city_name(v.city))}" + (f", {e(v.address)}" if v.address else ""))
    # Одна ссылка отклика: окно отклика в приложении, откуда человек пишет работодателю с профилем.
    # У вакансий от работодателей и смен свой отклик через бота, им ссылка не нужна
    if url := launch.apply_link(v, "bot"):
        lines.append(f'<a href="{e(url)}">✉️ Откликнуться</a>')
    return "\n".join(lines)


# Подписи кнопок отклика на карточке сайта (переводятся в шаблоне)
REPLY_LABELS = {"whatsapp": "💬 Написать в WhatsApp", "phone": "📞 Позвонить", "telegram": "✈️ Написать в Telegram",
                "apply": "Откликнуться в приложении"}


def app_replies(v: Vacancy) -> list[tuple[str, str, str | None]]:
    """Кнопки отклика через приложение для карточки сайта: [(подпись, ссылка, вид нажатия для счётчика)].
    Вид «app» у кнопки в мини-приложение (static/via.js). У прямых кнопок связи вида нет: их нажатия сервер
    считает сам, на переходе /go/."""
    return [(REPLY_LABELS[kind], url, "app" if kind == "apply" else None)
            for kind, url in launch.reply_buttons(v, "web")]


def age_label(posted_at: str, now: datetime, lang: str = "ru") -> str:
    days = (now.date() - datetime.fromisoformat(posted_at).date()).days
    if days <= 0:
        return i18n.t(lang, "сегодня")
    if days == 1:
        return i18n.t(lang, "вчера")
    return i18n.t(lang, "{days} дн. назад", days=days)


def more_links(city: str | None, category: str | None = None) -> list[tuple[str, str]]:
    """Куда ещё посмотреть вакансии этого города: [(название, адрес)]."""
    hh = f"https://hh.kz/search/vacancy?area={HH_AREAS.get(city or '', 40)}"
    if category in HH_QUERIES:
        hh += "&text=" + quote(HH_QUERIES[category])
    olx = "https://www.olx.kz/rabota/" + (f"{OLX_CITIES[city]}/" if city in OLX_CITIES else "")
    return [("hh.kz", hh), ("OLX", olx)]


def city_name(slug: str | None, lang: str = "ru") -> str:
    if lang == "kk":
        return i18n.CITIES_KK.get(slug or "", "Қазақстан")
    return CITIES[slug][0] if slug in CITIES else "Казахстан"


def category_name(cat: str, lang: str = "ru") -> str:
    return i18n.CATEGORIES_KK[cat] if lang == "kk" else CATEGORIES[cat]


def _env(lang: str = "ru") -> Environment:
    """Шаблоны для одного языка: все подписи, города, сферы и зарплаты выходят на нём."""
    env = Environment(
        loader=FileSystemLoader(HERE / "templates"),
        autoescape=select_autoescape(["html", "xml"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    env.globals.update(city_name=lambda slug: city_name(slug, lang), city_in=lambda slug: city_in(slug, lang),
                       cat_name=lambda c: category_name(c, lang),
                       salary_label=lambda v: salary_label(v, lang), twogis_url=twogis_url,
                       app_replies=app_replies, profile_link=lambda v: launch.profile_link(v, "web"),
                       monthly_pay=monthly_pay, monthly_label=lambda v: monthly_label(v, lang),
                       search_text=lambda v: search_text(v, lang), money=money, perks_of=shifts.perks,
                       shift_day=lambda v: shifts.day_label(v.shift_date, lang),
                       SHIFTS=shifts.SLUG, shift_post_url=f"https://t.me/{BOT_USERNAME}?start=smena_site",
                       FILTER_PERKS=FILTER_PERKS, PAGE_SIZE=PAGE_SIZE, employer_url=POST_URL, form_url=FORM_URL, instagram_url=instagram_url,
                       site_name=site_name, more_links=more_links, initial=initial, lang=lang, LANGS=i18n.LANGS,
                       LANG_NAME=i18n.LANG_NAME, t=lambda text, **kw: i18n.t(lang, text, **kw),
                       title=lambda v: i18n.title(v, lang), perk=lambda p: i18n.perk(p, lang),
                       # Сервер, куда static/via.js отправляет нажатия на кнопки отклика
                       api_url=launch.GO_URL)
    env.filters["plural"] = lambda n, *forms: plural(n, *forms, lang=lang)
    env.filters["tenge"] = lambda n: f"{money(n)} ₸"
    return env


def lang_path(lang: str, path: str) -> str:
    """Путь страницы на языке: «almaty/horeca» → «kk/almaty/horeca», главная «» → «kk»."""
    return "/".join(p for p in (i18n.PREFIX[lang], path) if p)


# Фон заглушки вместо аватара: спокойные тона, на всех читается белая буква в светлой и тёмной теме
INITIAL_COLORS = ["#5b7db1", "#4f9a8a", "#b0735a", "#8a6bb0", "#a3864a", "#5e8f5a", "#b05f7a", "#6a7f8f"]


def initial(name: str) -> tuple[str, str]:
    """Заглушка аватара: первая буква названия (без кавычек и «ТОО») и цвет, постоянный для этого названия."""
    clean = venue_store.key(name, None).split(":", 1)[1]
    letter = next((c for c in clean if c.isalnum()), "•").upper()
    return letter, INITIAL_COLORS[zlib.crc32(clean.encode()) % len(INITIAL_COLORS)]


def instagram_url(venue: dict | None) -> str | None:
    return f"https://www.instagram.com/{venue['instagram']}/" if venue and venue.get("instagram") else None


def site_name(url: str) -> str:
    """«https://www.dinofest.kz/» → «dinofest.kz», «https://taplink.cc/dinofest» → «taplink.cc/dinofest»."""
    parts = urlparse(url)
    return (parts.netloc.removeprefix("www.") + parts.path).rstrip("/")


_TRANSLIT = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюяәғқңөұүһі",
                     ["a", "b", "v", "g", "d", "e", "e", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p", "r", "s",
                      "t", "u", "f", "h", "c", "ch", "sh", "sch", "", "y", "", "e", "yu", "ya", "a", "g", "k", "n",
                      "o", "u", "u", "h", "i"]))


def slugify(text: str) -> str:
    """«Оператор колл-центра» → «operator-koll-centra»: адрес страницы профессии латиницей."""
    out = "".join(_TRANSLIT.get(c, c) for c in text.lower())
    return re.sub(r"[^a-z0-9]+", "-", out).strip("-")


# Профессии для страниц «Официант: вакансии в Алматы»: должности, которые знает разбор (у них есть казахский перевод)
PROFESSIONS = {slugify(name): name for name in i18n.TITLES_KK if name not in PROFESSION_SKIP}


def professions_of(v: Vacancy) -> list[str]:
    """Слаги профессий вакансии: «Повар холодного цеха» попадает и к поварам, «Продавец-кассир» и к продавцам."""
    parts = [p.strip().lower() for p in v.title.split(",")]
    found = []
    for slug, name in PROFESSIONS.items():
        low = name.lower()
        if any(p == low or p.startswith(low + " ") or p.startswith(low + "-") for p in parts):
            found.append(slug)
    return found


def profession_heading(slug: str, city: str, lang: str) -> str:
    """«Официант: вакансии в Алматы» / «Даяшы: Алматыдағы жұмыс»."""
    name = PROFESSIONS[slug]
    if lang == "kk":
        return f"{i18n.TITLES_KK[name]}: {city_heading(city, lang)}"
    return f"{name}: вакансии в {_locative(city)}"


def valid_through(v: Vacancy) -> datetime:
    """До какого времени страница вакансии будет на сайте: срок хранения от публикации (store.expire),
    оплаченное «🔥 Срочно» держит её дольше, а смена на конкретный день уходит, когда этот день прошёл."""
    until = datetime.fromisoformat(v.posted_at) + timedelta(days=MAX_AGE_DAYS)
    if v.top_until:
        until = max(until, datetime.fromisoformat(v.top_until))
    if v.shift_date:
        until = min(until, datetime.combine(date.fromisoformat(v.shift_date) + timedelta(days=1), time.min, LOCAL))
    return until


def job_posting_ld(v: Vacancy, base_url: str, venue: dict | None = None) -> str | None:
    """Разметка JobPosting для Google Jobs. Google требует работодателя; если он не назван, Google разрешает
    «confidential», но такое объявление размечаем, только когда в нём есть суть: город, зарплата и текст
    не короче CONFIDENTIAL_TEXT знаков. Короткие посты без работодателя и зарплаты в Google Jobs не нужны."""
    if not v.employer and not (v.city and (v.salary_min or v.salary_max) and len(v.text) >= CONFIDENTIAL_TEXT):
        return None
    posted = datetime.fromisoformat(v.posted_at)
    address = {"@type": "PostalAddress", "addressLocality": city_name(v.city), "addressCountry": "KZ"}
    if v.address:
        address["streetAddress"] = v.address
    place: dict = {"@type": "Place", "address": address}
    if v.lat is not None and v.lon is not None and not v.approx:
        place["geo"] = {"@type": "GeoCoordinates", "latitude": v.lat, "longitude": v.lon}
    data = {
        "@context": "https://schema.org/",
        "@type": "JobPosting",
        "title": v.title,
        # Описание в HTML: текст экранируем, переносы строк — <br>
        "description": html.escape(v.text).replace("\n", "<br>"),
        "identifier": {"@type": "PropertyValue", "name": "vacante.kz", "value": v.id},
        "datePosted": posted.date().isoformat(),
        # Не дольше, чем живёт страница: иначе Google считает объявление открытым, а по ссылке уже 404
        "validThrough": valid_through(v).isoformat(),
        "hiringOrganization": {"@type": "Organization", "name": v.employer or "confidential"},
        "jobLocation": place,
        "url": f"{base_url}/v/{v.id}/",
    }
    if v.schedule:
        data["workHours"] = v.schedule
    if shifts.is_shift(v):
        data["employmentType"] = ["PART_TIME", "TEMPORARY"]
    if venue and venue.get("avatar"):
        data["hiringOrganization"]["logo"] = f"{base_url}/{venue_store.AVATARS}/{venue['avatar']}"
    if same := [u for u in (instagram_url(venue), venue and venue.get("website")) if u]:
        data["hiringOrganization"]["sameAs"] = same[0] if len(same) == 1 else same
    if v.salary_min or v.salary_max:
        unit = {"month": "MONTH", "day": "DAY", "hour": "HOUR"}[v.salary_period]
        value = {"@type": "QuantitativeValue", "unitText": unit}
        if v.salary_min:
            value["minValue"] = v.salary_min
        if v.salary_max:
            value["maxValue"] = v.salary_max
        data["baseSalary"] = {"@type": "MonetaryAmount", "currency": "KZT", "value": value}
    return ld_json(data)


# data-поля карточки нужны странице, только когда карточки лежат в самом HTML; в cards.json они в отдельных полях
_DATA_ATTRS = re.compile(r' data-[a-z]+="[^"]*"')


def pay_of(v: Vacancy, period: str = "month") -> int | None:
    """Оплата вакансии одним числом, середина вилки, если она названа за period; иначе None."""
    if v.salary_period != period or not (v.salary_min or v.salary_max):
        return None
    return ((v.salary_min or v.salary_max) + (v.salary_max or v.salary_min)) // 2


def pay_stats(items: list[Vacancy], period: str = "month") -> tuple[int, int, int, int] | None:
    """Свои данные о зарплатах для страницы списка: (сколько вакансий, медиана, нижняя и верхняя четверть)
    в тенге в месяц. Только вакансии с месячной оплатой: смены и часы в пересчёте исказили бы картину.
    period="day" — то же по вакансиям с оплатой за смену, в тенге за смену (раздел «Подработка и смены»)."""
    pays = sorted(pay for pay in (pay_of(v, period) for v in items) if pay)
    if len(pays) < 5:
        return None
    digits = -3 if period == "month" else -2  # месячные суммы округляем до тысяч, оплату за смену до сотен
    pick = lambda share: round(pays[min(len(pays) - 1, int(len(pays) * share))], digits)  # noqa: E731
    return len(pays), pick(0.5), pick(0.25), pick(0.75)


def pay_level(pay: int, median: int) -> str:
    """Зарплата вакансии рядом с медианой похожих: отличие до 10% в любую сторону — «на уровне»."""
    if pay * 10 > median * 11:
        return "выше медианы"
    if pay * 10 < median * 9:
        return "ниже медианы"
    return "на уровне медианы"


def fresh_counts(items: list[Vacancy], now: datetime) -> tuple[int, int]:
    """Сколько вакансий списка опубликовано за последние сутки и за три дня."""
    ages = [now - datetime.fromisoformat(v.posted_at) for v in items]
    return sum(age < timedelta(days=1) for age in ages), sum(age < timedelta(days=3) for age in ages)


def fresh_line(day: int, three: int, now: datetime, lang: str) -> str | None:
    """Строка под заголовком списка: когда он собран (время Казахстана) и сколько в нём новых вакансий за сутки
    и за три дня (fresh_counts). Дата числом, а не «сегодня»: страницу читают и из кеша поисковика, спустя дни.
    Новых за три дня нет — строки нет: «0 новых» читателю ничего не говорит."""
    if not three:
        return None
    local = now.astimezone(LOCAL)
    values = {"date": f"{local:%d.%m}", "time": f"{local:%H:%M}", "day": day, "three": three,
              "new": plural(day or three, "новая вакансия", "новые вакансии", "новых вакансий", lang)}
    if not day:
        return i18n.t(lang, "Обновлено {date} в {time}: {three} {new} за три дня.", **values)
    if day == three:
        return i18n.t(lang, "Обновлено {date} в {time}: {day} {new} за сутки.", **values)
    return i18n.t(lang, "Обновлено {date} в {time}: {day} {new} за сутки, {three} за три дня.", **values)


def ld_json(data: dict | list) -> str:
    """JSON-LD для <script>: «</» внутри текста не закроет тег."""
    return json.dumps(data, ensure_ascii=False).replace("</", "<\\/")


def breadcrumbs_ld(items: list[tuple[str, str]]) -> str:
    """Хлебные крошки для Google: [(название, полный адрес)]."""
    return ld_json({"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
        {"@type": "ListItem", "position": i, "name": name, "item": url} for i, (name, url) in enumerate(items, 1)]})


def site_ld(base_url: str, lang: str) -> str:
    """Сайт и организация на главной: название в выдаче и логотип."""
    home = base_url + ("/kk/" if lang == "kk" else "/")
    return ld_json([
        {"@context": "https://schema.org", "@type": "WebSite", "name": "vacante.kz", "url": home,
         "inLanguage": lang},
        {"@context": "https://schema.org", "@type": "Organization", "name": "vacante.kz", "url": base_url + "/",
         "logo": f"{base_url}/static/icon-512.png",
         "sameAs": ["https://t.me/vacantealmaty", "https://t.me/vacanteastana", f"https://t.me/{BOT_USERNAME}"]},
    ])


def closed_parts(archive: dict[str, dict], live: set[str], written: set[str]) -> dict[int, dict[str, list[str]]]:
    """Архив закрытых вакансий (vacante.closed) частями для страницы 404: {номер части: {id: [название,
    казахское название, если оно другое, город, страница списка]}}. Страница списка — лучшая из тех, что есть
    в этой сборке (written): профессия в городе, иначе сфера в городе, иначе город, иначе пусто.
    Вакансий, которые сейчас на сайте (live), в частях нет."""
    parts: dict[int, dict[str, list[str]]] = defaultdict(dict)
    for key, item in archive.items():
        if key in live:
            continue
        city = item["city"] if item["city"] in CITIES else ""
        named = SimpleNamespace(title=item["title"], title_kk=item.get("title_kk"))  # всё, что нужно названию и профессиям
        places = [f"{city}/{prof}" for prof in professions_of(named)] + [f"{city}/{item['category']}", city]
        title_kk = i18n.title(named, "kk")
        parts[closed.shard(key)][key] = [item["title"], title_kk if title_kk != item["title"] else "", city,
                                         next((p for p in places if p in written), "") if city else ""]
    return parts


def similar_of(items: list, i: int, k: int = SIMILAR) -> list:
    """«Похожие» для items[i] из той же сферы города (список от новых к старым): соседи по времени, по два с каждой
    стороны, и два прыжка на треть и две трети списка. Раньше все вакансии ссылались на одни и те же шесть новейших,
    и до старых поисковый робот не доходил: страницы списков показывают только новые карточки. Так на каждую
    вакансию ведут ссылки с соседей, а прыжки укорачивают путь к любой из них."""
    n = len(items)
    if n <= k + 1:
        return [o for j, o in enumerate(items) if j != i]
    near = k - 2
    newer = min(i, near // 2)
    older = min(n - 1 - i, near - newer)
    newer = min(i, near - older)
    picked = list(range(i - newer, i)) + list(range(i + 1, i + 1 + older))
    for step in (n // 3, 2 * n // 3):
        j = (i + step) % n
        while j == i or j in picked:
            j = (j + 1) % n
        picked.append(j)
    return [items[j] for j in picked]


def gone_data(root: str) -> str:
    """Данные для скрипта страницы 404: тексты на обоих языках (0 — русский, 1 — казахский) и города в форме «где»;
    под пустым ключом — вся страна, для ссылки на главную."""
    texts = ["Вакансия «{title}» в {where} закрыта", "Вакансия «{title}» закрыта", "Похожие вакансии в {where}",
             "Работа в {where}"]
    return ld_json({"root": root, "shards": closed.SHARDS,
                    "texts": [[i18n.t(lang, text) for text in texts] for lang in i18n.LANGS],
                    "cities": {slug: [city_in(slug or None, lang) for lang in i18n.LANGS] for slug in ("", *CITIES)}})


def build(data_dir: Path, out: Path, base_url: str = "https://vacante.kz", now: datetime | None = None,
          admin_password: str | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    base_url = base_url.rstrip("/")
    vacancies = sorted(load_vacancies(data_dir), key=lambda v: v.posted_at, reverse=True)
    # Оплаченные «🔥 Срочно» первыми во всех списках, дальше по новизне
    vacancies.sort(key=lambda v: not v.is_top(now))
    venues = venue_store.load(data_dir)
    tg_channels = telegram_channels(data_dir)
    envs = {lang: _env(lang) for lang in i18n.LANGS}
    # root: путь сайта без домена, чтобы ссылки работали и на vacante.kz, и на <user>.github.io/vacante;
    # home: начало ссылок на страницы этого языка (/kk для казахской версии)
    root = urlparse(base_url).path.rstrip("/")
    for lang, lang_env in envs.items():
        lang_env.globals.update(age=lambda v, lang=lang: age_label(v.posted_at, now, lang), base_url=base_url,
                                top=lambda v: v.is_top(now), root=root,
                                home=root + (f"/{i18n.PREFIX[lang]}" if i18n.PREFIX[lang] else ""),
                                venue=lambda v: venue_store.lookup(venues, v), **SITE_TAGS)
    env = envs["ru"]

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    shutil.copytree(HERE / "static", out / "static")
    if (data_dir / venue_store.AVATARS).is_dir():
        shutil.copytree(data_dir / venue_store.AVATARS, out / venue_store.AVATARS)
    # Пути страниц без языка, дата их изменения и языки, которые идут в sitemap: обычно русская и казахская
    pages: list[tuple[str, str, tuple[str, ...]]] = []
    today = now.date().isoformat()

    def write(path: str, template: str, lastmod: str = today, ru_only: bool = False, **ctx) -> None:
        """Страница на всех языках: русская по path, казахская по kk/path. В ctx значения или функции от языка.
        ru_only: казахская версия есть для людей, но каноническая у неё русская, и в sitemap идёт только русская."""
        for lang, lang_env in envs.items():
            full = lang_path(lang, path)
            target = out / full / "index.html" if full else out / "index.html"
            target.parent.mkdir(parents=True, exist_ok=True)
            values = {k: v(lang) if callable(v) else v for k, v in ctx.items()}
            target.write_text(lang_env.get_template(template).render(path=full, page=path, ru_only=ru_only, **values),
                              "utf-8")
        pages.append((path, lastmod, ("ru",) if ru_only else tuple(envs)))

    card_cache: dict[tuple[str, str], list] = {}

    def card_row(v: Vacancy, lang: str) -> list:
        """Карточка для cards.json: id, готовый HTML без data-полей и поля, по которым фильтрует страница."""
        key = (lang, v.id)
        if key not in card_cache:
            card = _DATA_ATTRS.sub("", envs[lang].get_template("_card.html").render(v=v))
            card_cache[key] = [v.id, card, v.posted_at, monthly_pay(v) or 0, v.category, "|".join(shifts.perks(v)),
                               search_text(v, lang)]
        return card_cache[key]

    def write_list(path: str, items: list[Vacancy], shared: str | None = None, **ctx) -> None:
        """Страница списка: первые PAGE_SIZE карточек в HTML, весь список в cards.json.
        Страницы внутри города (сфера, профессия, смены) берут карточки из cards.json города (shared)
        и показывают из него только свои id: так одна карточка не лежит на сайте пять раз."""
        if len(items) <= PAGE_SIZE:
            src, ids = "", ""
        elif shared is not None:
            src = lambda lang: f"{root}/{lang_path(lang, shared)}/cards.json"  # noqa: E731
            ids = " ".join(v.id for v in items)
        else:
            src = lambda lang: f"{root}/{lang_path(lang, path)}/".replace("//", "/") + "cards.json"  # noqa: E731
            ids = ""
            for lang in envs:
                full = lang_path(lang, path)
                (out / full if full else out).mkdir(parents=True, exist_ok=True)
                ((out / full if full else out) / "cards.json").write_text(
                    json.dumps([card_row(v, lang) for v in items], ensure_ascii=False, separators=(",", ":")), "utf-8")
        day, three = fresh_counts(items, now)
        write(path, "list.html", vacancies=items, total=len(items), cards=src, ids=ids, stats=pay_stats(items),
              shift_stats=pay_stats(items, "day") if ctx.get("shifts_page") else None,
              fresh=lambda lang: fresh_line(day, three, now, lang), **ctx)

    by_city: dict[str, list[Vacancy]] = defaultdict(list)
    for v in vacancies:
        if v.city:
            by_city[v.city].append(v)
    city_counts = sorted(((slug, len(items)) for slug, items in by_city.items()), key=lambda x: -x[1])
    shift_cities = {slug for slug, items in by_city.items() if any(shifts.is_shift(v) for v in items)}
    # Профессии по городам: {город: {слаг: [вакансии]}}, только где вакансий хватает на страницу
    by_prof: dict[str, dict[str, list[Vacancy]]] = {}
    for slug, items in by_city.items():
        found: dict[str, list[Vacancy]] = defaultdict(list)
        for v in items:
            for prof in professions_of(v):
                found[prof].append(v)
        by_prof[slug] = dict(sorted(((k, vs) for k, vs in found.items() if len(vs) >= PROFESSION_MIN),
                                    key=lambda kv: -len(kv[1])))

    def prof_of(v: Vacancy) -> str | None:
        """Страница профессии этой вакансии, если она есть: для крошек и ссылок."""
        return next((p for p in professions_of(v) if p in by_prof.get(v.city or "", {})), None)

    for lang, lang_env in envs.items():
        lang_env.globals.update(shift_cities=shift_cities, all_cities=city_counts, prof_of=prof_of,
                                prof_name=lambda slug, lang=lang: (i18n.TITLES_KK[PROFESSIONS[slug]] if lang == "kk"
                                                                    else PROFESSIONS[slug]))

    # Фильтры и сортировка работают в браузере по всему списку (cards.json), в HTML только первые карточки
    write_list("", vacancies, heading=lambda lang: city_heading(None, lang),
               city=None, category=None, city_counts=city_counts, category_counts=_category_counts(vacancies),
               channels=tg_channels, ld=lambda lang: site_ld(base_url, lang))

    for slug, items in by_city.items():
        professions = [(p, len(vs)) for p, vs in by_prof[slug].items()]
        write_list(slug, items, heading=lambda lang: city_heading(slug, lang),
                   city=slug, category=None, city_counts=city_counts, category_counts=_category_counts(items),
                   channels=tg_channels, professions=professions)
        by_cat: dict[str, list[Vacancy]] = defaultdict(list)
        for v in items:
            by_cat[v.category].append(v)
        for cat, cat_items in by_cat.items():
            write_list(f"{slug}/{cat}", cat_items, slug,
                       heading=lambda lang: category_heading(cat, slug, lang),
                       city=slug, category=cat, city_counts=city_counts,
                       category_counts=_category_counts(items), channels=tg_channels)
        for prof, prof_items in by_prof[slug].items():
            write_list(f"{slug}/{prof}", prof_items, slug, heading=lambda lang: profession_heading(prof, slug, lang),
                       city=slug, category=None, profession=prof, city_counts=city_counts,
                       category_counts=_category_counts(prof_items), channels=tg_channels, professions=professions)
        # «Подработка и смены в Алматы»: оплата за смену или час, ежедневная оплата, подработка (vacante.shifts)
        shift_items = shifts.ordered([v for v in items if shifts.is_shift(v)])
        if shift_items:
            write_list(f"{slug}/{shifts.SLUG}", shift_items, slug, heading=lambda lang: shifts_heading(slug, lang),
                       city=slug, category=None, shifts_page=True,
                       city_counts=city_counts, category_counts=_category_counts(shift_items), channels=tg_channels)

    all_shifts = shifts.ordered([v for v in vacancies if shifts.is_shift(v)])
    write_list(shifts.SLUG, all_shifts, heading=lambda lang: shifts_heading(None, lang),
               city=None, category=None, shifts_page=True, city_counts=city_counts,
               category_counts=_category_counts(all_shifts), channels=tg_channels)

    # Политика конфиденциальности: на неё ссылаются подвал сайта и страница приложения в Google Play
    write("privacy", "privacy.html")
    # Страница для работодателей: где выйдет вакансия, как придут отклики, сколько стоит. На неё ведёт кнопка в шапке
    write("rabotodatelyam", "employers.html", channels=tg_channels, prices=employer_prices())

    by_city_cat: dict[tuple[str | None, str], list[Vacancy]] = defaultdict(list)
    place_in: dict[str, int] = {}  # место вакансии в списке её сферы города
    for v in vacancies:
        place_in[v.id] = len(by_city_cat[(v.city, v.category)])
        by_city_cat[(v.city, v.category)].append(v)
    # Медиана месячной зарплаты по профессии в городе и по сфере в городе: с ней страница вакансии сравнивает свою
    prof_pay = {(city, prof): pay_stats(items) for city, found in by_prof.items() for prof, items in found.items()}
    cat_pay = {key: pay_stats(items) for key, items in by_city_cat.items()}

    def pay_note(v: Vacancy) -> tuple[str, bool, int, int, str] | None:
        """Строка о медиане на странице вакансии: (страница списка, профессия ли это, по скольким вакансиям медиана,
        сама медиана, где рядом с ней зарплата вакансии). Сравниваем с той же профессией в городе, а где таких
        вакансий с месячной зарплатой меньше пяти — со сферой. «Другое» не сфера: с ним не сравниваем."""
        pay = pay_of(v)
        if not pay or not v.city:
            return None
        prof = next((p for p in professions_of(v) if prof_pay.get((v.city, p))), None)
        stats = prof_pay[(v.city, prof)] if prof else cat_pay[(v.city, v.category)] if v.category != "other" else None
        return (prof or v.category, bool(prof), stats[0], stats[1], pay_level(pay, stats[1])) if stats else None

    for v in vacancies:
        # Разметка для Google Jobs только на русской странице: одна вакансия — одно объявление
        job = job_posting_ld(v, base_url, venue_store.lookup(venues, v))
        similar = similar_of(by_city_cat[(v.city, v.category)], place_in[v.id])
        write(f"v/{v.id}", "vacancy.html", lastmod=v.posted_at[:10], ru_only=True, v=v, similar=similar, channels=tg_channels,
              pay_note=pay_note(v), job=lambda lang: job if lang == "ru" else None,
              crumbs=lambda lang, v=v: vacancy_crumbs(v, base_url, lang, prof_of(v)))

    # Страница 404 и архив закрытых вакансий для неё: по ссылке на ушедшую вакансию она называет её и ведёт к похожим
    parts = closed_parts(closed.load(data_dir), {v.id for v in vacancies}, {path for path, _, _ in pages})
    if parts:
        (out / "closed").mkdir()
    for number, rows in parts.items():
        (out / "closed" / f"{number}.json").write_text(
            json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":")), "utf-8")
    (out / "404.html").write_text(env.get_template("404.html").render(path="404", page="404", gone=gone_data(root)),
                                  "utf-8")
    # Свежие вакансии для бота: по ним он показывает первые примеры сразу после подписки. Больше html из этого
    # файла никуда не идёт (bot/src/logic.js, examples), поэтому ссылки в нём помечены как «examples»
    feed = [{"id": v.id, "city": v.city, "category": v.category, "perks": shifts.perks(v), "pay": monthly_pay(v) or 0,
             "html": bot_item(v, base_url, "examples")} for v in vacancies[:FEED_SIZE]]
    # channels: свои каналы по городам (город → @канал), бот пишет работодателю, в каком канале выйдет вакансия
    (out / "feed.json").write_text(json.dumps({"vacancies": feed, "channels": channels.live(data_dir)},
                                              ensure_ascii=False), "utf-8")
    # Лента приложения со свайпами (app/ в репозитории): вакансии по городам
    appfeed.write(out, vacancies, base_url, now, venues)
    # Админка: не в sitemap и закрыта от индексации. Данные только зашифрованные паролем владельца,
    # страница сама спрашивает пароль и расшифровывает их. Без пароля данных нет вовсе.
    (out / "admin").mkdir()
    (out / "admin" / "index.html").write_text(env.get_template("admin.html").render(path="admin", page="admin"),
                                              "utf-8")
    if admin_password:
        sealed = seal(admin_data(data_dir, vacancies, tg_channels, now), admin_password)
        (out / "admin" / "sealed.json").write_text(json.dumps(sealed), "utf-8")
    (out / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {base_url}/sitemap.xml\n", "utf-8")
    (out / "sitemap.xml").write_text(env.get_template("sitemap.xml").render(pages=pages, lang_path=lang_path),
                                     "utf-8")
    # IndexNow (Bing, Yandex и др.): файл с ключом в корне подтверждает, что адреса присылаем мы (vacante/indexnow.py)
    (out / f"{INDEXNOW_KEY}.txt").write_text(INDEXNOW_KEY, "utf-8")
    if base_url.startswith("https://") and "github.io" not in base_url:
        (out / "CNAME").write_text(base_url.removeprefix("https://") + "\n", "utf-8")
    return len(pages) * len(i18n.LANGS)


def vacancy_crumbs(v: Vacancy, base_url: str, lang: str, prof: str | None) -> str:
    """Крошки вакансии для Google: Вакансии › Город › Профессия или сфера › Вакансия."""
    home = base_url + ("/kk" if lang == "kk" else "")
    items = [(i18n.t(lang, "Вакансии"), home + "/")]
    if v.city:
        items.append((city_name(v.city, lang), f"{home}/{v.city}/"))
        if prof:
            name = PROFESSIONS[prof]
            items.append((i18n.TITLES_KK[name] if lang == "kk" else name, f"{home}/{v.city}/{prof}/"))
        else:
            items.append((category_name(v.category, lang), f"{home}/{v.city}/{v.category}/"))
    items.append((i18n.title(v, lang), f"{home}/v/{v.id}/"))
    return breadcrumbs_ld(items)


def _category_counts(items: list[Vacancy]) -> list[tuple[str, int]]:
    counts: dict[str, int] = defaultdict(int)
    for v in items:
        counts[v.category] += 1
    return sorted(counts.items(), key=lambda x: -x[1])


_LOCATIVE = {"almaty": "Алматы", "astana": "Астане", "shymkent": "Шымкенте", "karaganda": "Караганде",
             "aktobe": "Актобе", "atyrau": "Атырау", "aktau": "Актау", "pavlodar": "Павлодаре",
             "ust-kamenogorsk": "Усть-Каменогорске", "semey": "Семее", "kostanay": "Костанае",
             "uralsk": "Уральске", "taraz": "Таразе", "turkestan": "Туркестане",
             "petropavlovsk": "Петропавловске", "kyzylorda": "Кызылорде",
             "kokshetau": "Кокшетау", "taldykorgan": "Талдыкоргане"}


def _locative(slug: str | None) -> str:
    """Город в предложном падеже, для «в …»: «Астане». Без города — «Казахстане»."""
    return _LOCATIVE.get(slug, city_name(slug)) if slug in CITIES else "Казахстане"


def city_in(slug: str | None, lang: str = "ru") -> str:
    """Город в форме «где», в текстах это {where}: «(в) Астане» по-русски, «Астанадағы» по-казахски."""
    if lang == "kk":
        return i18n.CITIES_KK_IN.get(slug, city_name(slug, lang)) if slug in CITIES else "Қазақстандағы"
    return _locative(slug)


def city_heading(slug: str | None, lang: str) -> str:
    """«Работа в Алматы» / «Алматыдағы жұмыс»; без города — заголовок главной: «Работа в Казахстане»."""
    return i18n.t(lang, "Работа в {where}", where=city_in(slug, lang))


def shifts_heading(slug: str | None, lang: str) -> str:
    """«Подработка и смены в Алматы» / «Алматыдағы қосымша жұмыс және ауысымдар»."""
    if lang == "kk":
        return f"{city_in(slug, lang)} қосымша жұмыс және ауысымдар"
    return f"Подработка и смены в {_locative(slug)}"


def category_heading(cat: str, slug: str, lang: str) -> str:
    """«Кафе и рестораны: работа в Алматы» / «Кафе мен мейрамханалар: Алматыдағы жұмыс»."""
    if lang == "kk":
        return f"{category_name(cat, lang)}: {city_heading(slug, lang)}"
    return f"{CATEGORIES[cat]}: работа в {_locative(slug)}"

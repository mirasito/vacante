"""Статический сайт-каталог из data/vacancies.json.

Страницы: главная, город, город + сфера (для поиска «работа официантом Алматы»),
карточка вакансии, sitemap.xml и robots.txt. Плюс админка /admin/ для владельца (см. site/admin.py).
"""

from __future__ import annotations

import html
import json
import re
import shutil
import zlib
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote, urlparse

from jinja2 import Environment, FileSystemLoader, select_autoescape

from vacante import channels
from vacante import venues as venue_store
from vacante.direct import POST_URL
from vacante.models import Vacancy
from vacante.parse import CATEGORIES, CITIES
from vacante.site import i18n
from vacante.site.admin import admin_data, seal
from vacante.store import load_vacancies

HERE = Path(__file__).parent
# Для фильтра «Зарплата от …»: смены и часы пересчитываем в полный месяц.
PER_MONTH = {"month": 1, "day": 22, "hour": 176}
# Условия, по которым можно отфильтровать список; «С зарплатой» проверяется отдельно.
FILTER_PERKS = ["Без опыта", "Питание", "Развозка", "Жильё", "Ежедневная оплата", "Можно студентам", "Официально"]


def telegram_channels(data_dir: Path) -> dict[str, str]:
    """Работающие свои каналы vacante по городам: кнопка подписки на страницах города."""
    return {city: f"https://t.me/{chat.lstrip('@')}" for city, chat in channels.live(data_dir).items()}

# Ссылки «Ещё вакансии» на поиск hh.kz и рубрику «Работа» OLX: только переход на их сайт, их данные
# мы не собираем (правила hh.kz запрещают автоматический сбор, OLX закрывает рубрику от ботов).
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
# Сколько первых символов текста объявления попадает в поиск на странице списка: страница
# содержит все вакансии города, и полный текст каждой сделал бы её слишком тяжёлой для телефона.
SEARCH_TEXT = 300
# Подтверждение сайта в Google Search Console и Яндекс Вебмастере (метатеги) и счётчик
# Яндекс Метрики. Значения публичные, они всё равно видны в коде страницы.
SITE_TAGS = {"google_verification": "GQjMSgo5pc-ADt2n0s-GBlVU9kMnuA9jWIZo2WQAejA",
             "yandex_verification": "5e4790f22ea3db3f", "metrika_id": "113822258"}
_MAP_WORTHY = re.compile(r"(?i)\d|\b(?:трц|трк|тц|тд|бц|жк)\b")


def money(value: int) -> str:
    return f"{value:,}".replace(",", " ")


def _range(lo: int | None, hi: int | None, unit: str, lang: str) -> str:
    """«от 200 000 ₸/мес» по-русски, «200 000 ₸/ай бастап» по-казахски."""
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


def bot_item(v: Vacancy, base_url: str) -> str:
    """Вакансия в подборке бота (HTML-разметка Telegram). Её же бот берёт из feed.json для первых примеров."""
    e = html.escape
    lines = [f'<b><a href="{base_url}/v/{v.id}/">{e(v.title)}</a></b>' + (f" · {e(v.employer)}" if v.employer else "")]
    facts = [f"💰 {e(s)}" for s in [salary_label(v)] if s] + ([f"🕒 {e(v.schedule)}"] if v.schedule else [])
    if facts:
        lines.append(" · ".join(facts))
    lines.append(f"📍 {e(city_name(v.city))}" + (f", {e(v.address)}" if v.address else ""))
    return "\n".join(lines)


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
    env.globals.update(city_name=lambda slug: city_name(slug, lang), cat_name=lambda c: category_name(c, lang),
                       salary_label=lambda v: salary_label(v, lang), twogis_url=twogis_url,
                       monthly_pay=monthly_pay, monthly_label=lambda v: monthly_label(v, lang),
                       search_text=lambda v: search_text(v, lang), money=money,
                       FILTER_PERKS=FILTER_PERKS, employer_url=POST_URL, instagram_url=instagram_url,
                       site_name=site_name, more_links=more_links, initial=initial, lang=lang, LANGS=i18n.LANGS,
                       LANG_NAME=i18n.LANG_NAME, t=lambda text, **kw: i18n.t(lang, text, **kw),
                       title=lambda v: i18n.title(v, lang), perk=lambda p: i18n.perk(p, lang))
    env.filters["plural"] = lambda n, *forms: plural(n, *forms, lang=lang)
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


def job_posting_ld(v: Vacancy, base_url: str, venue: dict | None = None) -> str | None:
    """Разметка JobPosting для Google Jobs. Google требует работодателя, без него не выводим."""
    if not v.employer:
        return None
    posted = datetime.fromisoformat(v.posted_at)
    data = {
        "@context": "https://schema.org/",
        "@type": "JobPosting",
        "title": v.title,
        "description": v.text.replace("\n", "<br>"),
        "datePosted": posted.date().isoformat(),
        "validThrough": (posted + timedelta(days=30)).isoformat(),
        "hiringOrganization": {"@type": "Organization", "name": v.employer},
        "jobLocation": {
            "@type": "Place",
            "address": {"@type": "PostalAddress", "addressLocality": city_name(v.city), "addressCountry": "KZ"},
        },
        "url": f"{base_url}/v/{v.id}/",
    }
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
    return json.dumps(data, ensure_ascii=False).replace("</", "<\\/")


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
    pages: list[str] = []  # пути страниц без языка: в sitemap каждая идёт русской и казахской

    def write(path: str, template: str, **ctx) -> None:
        """Страница на всех языках: русская по path, казахская по kk/path. В ctx значения или функции от языка."""
        for lang, lang_env in envs.items():
            full = lang_path(lang, path)
            target = out / full / "index.html" if full else out / "index.html"
            target.parent.mkdir(parents=True, exist_ok=True)
            values = {k: v(lang) if callable(v) else v for k, v in ctx.items()}
            target.write_text(lang_env.get_template(template).render(path=full, page=path, **values), "utf-8")
        pages.append(path)

    by_city: dict[str, list[Vacancy]] = defaultdict(list)
    for v in vacancies:
        if v.city:
            by_city[v.city].append(v)
    city_counts = sorted(((slug, len(items)) for slug, items in by_city.items()), key=lambda x: -x[1])

    # На страницах списка все вакансии: фильтры и сортировка работают в браузере и должны видеть каждую
    write("", "list.html", heading=lambda lang: i18n.t(lang, "Вакансии"), vacancies=vacancies, total=len(vacancies),
          city=None, category=None, city_counts=city_counts, category_counts=_category_counts(vacancies),
          channels=tg_channels)

    for slug, items in by_city.items():
        write(slug, "list.html", heading=lambda lang: city_heading(slug, lang), vacancies=items, total=len(items),
              city=slug, category=None, city_counts=city_counts, category_counts=_category_counts(items),
              channels=tg_channels)
        by_cat: dict[str, list[Vacancy]] = defaultdict(list)
        for v in items:
            by_cat[v.category].append(v)
        for cat, cat_items in by_cat.items():
            write(f"{slug}/{cat}", "list.html",
                  heading=lambda lang: category_heading(cat, slug, lang),
                  vacancies=cat_items, total=len(cat_items), city=slug, category=cat, city_counts=city_counts,
                  category_counts=_category_counts(items), channels=tg_channels)

    for v in vacancies:
        # Разметка для Google Jobs только на русской странице: одна вакансия — одно объявление
        ld = job_posting_ld(v, base_url, venue_store.lookup(venues, v))
        write(f"v/{v.id}", "vacancy.html", v=v, ld=lambda lang: ld if lang == "ru" else None, channels=tg_channels)

    (out / "404.html").write_text(env.get_template("404.html").render(path="404", page="404"), "utf-8")
    # Свежие вакансии для бота: по ним он показывает первые примеры сразу после подписки
    feed = [{"id": v.id, "city": v.city, "category": v.category, "perks": v.perks, "pay": monthly_pay(v) or 0,
             "html": bot_item(v, base_url)} for v in vacancies[:FEED_SIZE]]
    (out / "feed.json").write_text(json.dumps({"vacancies": feed}, ensure_ascii=False), "utf-8")
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
    if base_url.startswith("https://") and "github.io" not in base_url:
        (out / "CNAME").write_text(base_url.removeprefix("https://") + "\n", "utf-8")
    return len(pages) * len(i18n.LANGS)


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


def _locative(slug: str) -> str:
    return _LOCATIVE.get(slug, city_name(slug))


def city_heading(slug: str, lang: str) -> str:
    """«Работа в Алматы» / «Алматыдағы жұмыс»."""
    if lang == "kk":
        return f"{i18n.CITIES_KK_IN.get(slug, city_name(slug, lang))} жұмыс"
    return f"Работа в {_locative(slug)}"


def category_heading(cat: str, slug: str, lang: str) -> str:
    """«Кафе и рестораны: работа в Алматы» / «Кафе мен мейрамханалар: Алматыдағы жұмыс»."""
    if lang == "kk":
        return f"{category_name(cat, lang)}: {city_heading(slug, lang)}"
    return f"{CATEGORIES[cat]}: работа в {_locative(slug)}"

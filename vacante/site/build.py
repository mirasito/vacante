"""Статический сайт-каталог из data/vacancies.json.

Страницы: главная, город, город + сфера (для поиска «работа официантом Алматы»),
карточка вакансии, sitemap.xml и robots.txt.
"""

from __future__ import annotations

import json
import shutil
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from vacante.models import Vacancy
from vacante.parse import CATEGORIES, CITIES
from vacante.store import load_vacancies

HERE = Path(__file__).parent
PERIOD_LABEL = {"month": "мес", "day": "день", "hour": "час"}
# Свои каналы vacante по городам: кнопка подписки на страницах города.
TELEGRAM_CHANNELS = {
    "astana": "https://t.me/vacanteastana",
    "almaty": "https://t.me/vacantealmaty",
}


def money(value: int) -> str:
    return f"{value:,}".replace(",", " ")


def salary_label(v: Vacancy) -> str | None:
    if v.salary_min is None and v.salary_max is None:
        return None
    unit = f"₸/{PERIOD_LABEL[v.salary_period]}"
    if v.salary_min is not None and v.salary_max is not None:
        return f"{money(v.salary_min)} – {money(v.salary_max)} {unit}"
    if v.salary_min is not None:
        return f"от {money(v.salary_min)} {unit}"
    return f"до {money(v.salary_max)} {unit}"


def age_label(posted_at: str, now: datetime) -> str:
    days = (now.date() - datetime.fromisoformat(posted_at).date()).days
    if days <= 0:
        return "сегодня"
    if days == 1:
        return "вчера"
    return f"{days} дн. назад"


def city_name(slug: str | None) -> str:
    return CITIES[slug][0] if slug in CITIES else "Казахстан"


def _env() -> Environment:
    env = Environment(
        loader=FileSystemLoader(HERE / "templates"),
        autoescape=select_autoescape(["html", "xml"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    env.globals.update(CATEGORIES=CATEGORIES, city_name=city_name, salary_label=salary_label)
    return env


def job_posting_ld(v: Vacancy, base_url: str) -> str | None:
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
    if v.salary_min or v.salary_max:
        unit = {"month": "MONTH", "day": "DAY", "hour": "HOUR"}[v.salary_period]
        value = {"@type": "QuantitativeValue", "unitText": unit}
        if v.salary_min:
            value["minValue"] = v.salary_min
        if v.salary_max:
            value["maxValue"] = v.salary_max
        data["baseSalary"] = {"@type": "MonetaryAmount", "currency": "KZT", "value": value}
    return json.dumps(data, ensure_ascii=False).replace("</", "<\\/")


def build(data_dir: Path, out: Path, base_url: str = "https://vacante.kz", now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    base_url = base_url.rstrip("/")
    vacancies = sorted(load_vacancies(data_dir), key=lambda v: v.posted_at, reverse=True)
    env = _env()
    env.globals.update(age=lambda v: age_label(v.posted_at, now), base_url=base_url)

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    shutil.copytree(HERE / "static", out / "static")
    pages: list[str] = []

    def write(path: str, template: str, **ctx) -> None:
        target = out / path / "index.html" if path else out / "index.html"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(env.get_template(template).render(path=path, **ctx), "utf-8")
        pages.append(f"{base_url}/{path}/" if path else f"{base_url}/")

    by_city: dict[str, list[Vacancy]] = defaultdict(list)
    for v in vacancies:
        if v.city:
            by_city[v.city].append(v)
    city_counts = sorted(((slug, len(items)) for slug, items in by_city.items()), key=lambda x: -x[1])

    write("", "list.html", heading="Вакансии", vacancies=vacancies[:300], total=len(vacancies),
          city=None, category=None, city_counts=city_counts, category_counts=_category_counts(vacancies),
          channels=TELEGRAM_CHANNELS)

    for slug, items in by_city.items():
        write(slug, "list.html", heading=f"Работа в {_locative(slug)}", vacancies=items[:300], total=len(items),
              city=slug, category=None, city_counts=city_counts, category_counts=_category_counts(items),
              channels=TELEGRAM_CHANNELS)
        by_cat: dict[str, list[Vacancy]] = defaultdict(list)
        for v in items:
            by_cat[v.category].append(v)
        for cat, cat_items in by_cat.items():
            write(f"{slug}/{cat}", "list.html", heading=f"{CATEGORIES[cat]}: работа в {_locative(slug)}",
                  vacancies=cat_items, total=len(cat_items), city=slug, category=cat, city_counts=city_counts,
                  category_counts=_category_counts(items), channels=TELEGRAM_CHANNELS)

    for v in vacancies:
        write(f"v/{v.id}", "vacancy.html", v=v, ld=job_posting_ld(v, base_url), channels=TELEGRAM_CHANNELS)

    (out / "404.html").write_text(env.get_template("404.html").render(path="404"), "utf-8")
    (out / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {base_url}/sitemap.xml\n", "utf-8")
    (out / "sitemap.xml").write_text(env.get_template("sitemap.xml").render(pages=pages), "utf-8")
    if base_url.startswith("https://") and "github.io" not in base_url:
        (out / "CNAME").write_text(base_url.removeprefix("https://") + "\n", "utf-8")
    return len(pages)


def _category_counts(items: list[Vacancy]) -> list[tuple[str, int]]:
    counts: dict[str, int] = defaultdict(int)
    for v in items:
        counts[v.category] += 1
    return sorted(counts.items(), key=lambda x: -x[1])


_LOCATIVE = {"almaty": "Алматы", "astana": "Астане", "shymkent": "Шымкенте", "karaganda": "Караганде",
             "aktobe": "Актобе", "atyrau": "Атырау", "aktau": "Актау", "pavlodar": "Павлодаре",
             "ust-kamenogorsk": "Усть-Каменогорске", "semey": "Семее", "kostanay": "Костанае",
             "uralsk": "Уральске", "taraz": "Таразе", "turkestan": "Туркестане",
             "petropavlovsk": "Петропавловске", "kyzylorda": "Кызылорде"}


def _locative(slug: str) -> str:
    return _LOCATIVE.get(slug, city_name(slug))

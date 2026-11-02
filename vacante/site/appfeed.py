"""Данные для приложения со свайпами (Expo: Telegram Mini App, Android, iOS).

Приложение читает статичные JSON с сайта: app/data/index.json (города и сферы) и
app/data/<город>.json (свежие вакансии города). Подписи сразу на двух языках, чтобы
приложению не нужно было знать правила сайта: ключи без суффикса по-русски, с «_kk» по-казахски.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from vacante import venues as venue_store
from vacante.models import Vacancy
from vacante.parse import CATEGORIES, CITIES
from vacante.site import i18n

# Сколько вакансий города попадает в ленту: свежие первыми, этого хватает на много дней свайпов,
# а файл остаётся лёгким для телефона (~300 КБ, сжимается при передаче)
PER_CITY = 400
# Начало текста объявления на обороте карточки
TEXT_SIZE = 600
DIR = "app/data"


def item(v: Vacancy, base_url: str, now: datetime, venues: dict) -> dict:
    from vacante.site.build import monthly_label, salary_label, twogis_url  # build импортирует этот модуль

    venue = venue_store.lookup(venues, v)
    data = {
        "id": v.id,
        "title": v.title,
        "title_kk": i18n.title(v, "kk"),
        "category": v.category,
        "employer": v.employer,
        "pay": salary_label(v, "ru"),
        "pay_kk": salary_label(v, "kk"),
        "monthly": monthly_label(v, "ru"),
        "monthly_kk": monthly_label(v, "kk"),
        "schedule": v.schedule,
        "perks": v.perks,
        "perks_kk": [i18n.perk(p, "kk") for p in v.perks],
        "address": v.address,
        "map": twogis_url(v),
        "posted_at": v.posted_at,
        "top": v.is_top(now),
        "url": f"{base_url}/v/{v.id}/",
        "source_url": v.source_url,
        "text": v.text[:TEXT_SIZE],
    }
    if venue and venue.get("avatar"):
        data["avatar"] = f"{base_url}/{venue_store.AVATARS}/{venue['avatar']}"
    return {k: val for k, val in data.items() if val not in (None, [], "")}


def write(out: Path, vacancies: list[Vacancy], base_url: str, now: datetime, venues: dict) -> None:
    """vacancies уже отсортированы: «🔥 Срочно» первыми, дальше по новизне."""
    folder = out / DIR
    folder.mkdir(parents=True, exist_ok=True)
    by_city: dict[str, list[Vacancy]] = {}
    for v in vacancies:
        if v.city in CITIES:
            by_city.setdefault(v.city, []).append(v)
    for slug, items in by_city.items():
        payload = {"city": slug, "updated_at": now.isoformat(timespec="seconds"),
                   "vacancies": [item(v, base_url, now, venues) for v in items[:PER_CITY]]}
        (folder / f"{slug}.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), "utf-8")
    index = {
        "updated_at": now.isoformat(timespec="seconds"),
        "cities": [{"slug": slug, "name": name, "name_kk": i18n.CITIES_KK.get(slug, name),
                    "count": len(by_city[slug])}
                   for slug, (name, _) in sorted(CITIES.items(), key=lambda c: -len(by_city.get(c[0], [])))
                   if slug in by_city],
        "categories": [{"slug": slug, "name": name, "name_kk": i18n.CATEGORIES_KK.get(slug, name)}
                       for slug, name in CATEGORIES.items()],
    }
    (folder / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), "utf-8")

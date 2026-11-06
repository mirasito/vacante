"""Данные для приложения со свайпами (Expo: Telegram Mini App, Android, iOS).

Приложение читает статичные JSON с сайта: app/data/index.json (города, сферы и профессии
для анкеты соискателя) и app/data/<город>.json (свежие вакансии города). Подписи сразу на двух языках, чтобы
приложению не нужно было знать правила сайта: ключи без суффикса по-русски, с «_kk» по-казахски.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from datetime import datetime
from pathlib import Path

from vacante import shifts
from vacante import venues as venue_store
from vacante.models import Vacancy
from vacante.parse import CATEGORIES, CITIES, PROFESSIONS
from vacante.site import i18n

# Сколько вакансий города попадает в ленту: свежие первыми, этого хватает на много дней свайпов,
# а файл остаётся лёгким для телефона (~300 КБ, сжимается при передаче)
PER_CITY = 400
# Начало текста объявления на обороте карточки
TEXT_SIZE = 600
DIR = "app/data"
# Фильтр «Профессия» ищет по всему городу, а не только по 400 свежим: для каждой профессии, у которой
# в городе есть вакансии дальше первых PER_CITY, отдельный файл app/data/<город>/<key>.json
PER_ROLE = 300


def role_key(title: str) -> str:
    """Короткое имя файла профессии: одинаковое в каждой сборке, приложение берёт его из index.json."""
    return hashlib.sha1(title.encode()).hexdigest()[:10]


def item(v: Vacancy, base_url: str, now: datetime, venues: dict) -> dict:
    from vacante.site.build import monthly_label, monthly_pay, salary_label, twogis_url  # build импортирует этот модуль

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
        # Верх вилки в пересчёте на месяц, ₸: фильтр «Зарплата от» в приложении
        "pay_month": monthly_pay(v),
        "schedule": v.schedule,
        "perks": v.perks,
        "perks_kk": [i18n.perk(p, "kk") for p in v.perks],
        "address": v.address,
        "map": twogis_url(v),
        # Точка адреса работы: приложение само считает, далеко ли она от дома человека
        "lat": v.lat,
        "lon": v.lon,
        # Точка из OpenStreetMap: рядом с расстоянием приложение пишет «© OpenStreetMap» (лицензия ODbL)
        "osm": True if v.geo == "osm" else None,
        # Точка примерная (середина улицы или микрорайона): приложение пишет «Примерно N км от дома»
        "approx": True if v.approx else None,
        "posted_at": v.posted_at,
        "top": v.is_top(now),
        "url": f"{base_url}/v/{v.id}/",
        "source_url": v.source_url,
        "text": v.text[:TEXT_SIZE],
        # Виды контактов в исходном посте (whatsapp, phone, telegram): кнопки окна «Как откликнуться?»
        "contact": v.contact,
        # Смена или подработка (vacante.shifts.kind): кнопка «Смены» в ленте и значок на карточке
        "shift": shifts.kind(v),
        # Смена на день от работодателя: «сб, 07.11», «10:00–22:00», сколько человек нужно
        "shift_day": shifts.day_label(v.shift_date) if v.shift_date else None,
        "shift_day_kk": shifts.day_label(v.shift_date, "kk") if v.shift_date else None,
        "shift_time": v.shift_time,
        "need": v.need,
    }
    if venue and venue.get("avatar"):
        data["avatar"] = f"{base_url}/{venue_store.AVATARS}/{venue['avatar']}"
    if venue:
        # Ссылки заведения для его страницы в приложении: Instagram, сайт, карточка 2ГИС
        links = {"instagram": venue.get("instagram"), "website": venue.get("website"),
                 "gis": venue.get("source") if "2gis." in (venue.get("source") or "") else None}
        links = {k: val for k, val in links.items() if val}
        if links:
            data["venue"] = links
    return {k: val for k, val in data.items() if val not in (None, [], "")}


def roles(vacancies: list[Vacancy]) -> list[dict]:
    """Профессии для анкеты «Кем хочу работать»: те же, что знает разбор, частые первыми."""
    counts = Counter(part for v in vacancies for part in v.title.split(", "))
    seen: dict[str, dict] = {}
    for _, title, category in PROFESSIONS:
        seen.setdefault(title, {"title": title, "title_kk": i18n.TITLES_KK.get(title, title), "category": category,
                                "key": role_key(title)})
    return sorted(seen.values(), key=lambda r: -counts[r["title"]])


def write(out: Path, vacancies: list[Vacancy], base_url: str, now: datetime, venues: dict) -> None:
    """vacancies уже отсортированы: «🔥 Срочно» первыми, дальше по новизне."""
    folder = out / DIR
    folder.mkdir(parents=True, exist_ok=True)
    by_city: dict[str, list[Vacancy]] = {}
    for v in vacancies:
        if v.city in CITIES:
            by_city.setdefault(v.city, []).append(v)
    for slug, items in by_city.items():
        # Остальные вакансии города страницами по PER_CITY: app/data/<город>/p2.json, p3.json…
        # Приложение догружает их при прокрутке ленты и когда включены фильтры
        pages = max(1, -(-len(items) // PER_CITY))
        payload = {"city": slug, "updated_at": now.isoformat(timespec="seconds"), "total": len(items), "pages": pages,
                   "vacancies": [item(v, base_url, now, venues) for v in items[:PER_CITY]]}
        (folder / f"{slug}.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), "utf-8")
        if pages > 1:
            (folder / slug).mkdir(parents=True, exist_ok=True)
        for n in range(2, pages + 1):
            chunk = items[(n - 1) * PER_CITY:n * PER_CITY]
            page = {"city": slug, "page": n, "vacancies": [item(v, base_url, now, venues) for v in chunk]}
            (folder / slug / f"p{n}.json").write_text(json.dumps(page, ensure_ascii=False, separators=(",", ":")), "utf-8")
        write_roles(folder / slug, items, base_url, now, venues)
    index = {
        "updated_at": now.isoformat(timespec="seconds"),
        "cities": [{"slug": slug, "name": name, "name_kk": i18n.CITIES_KK.get(slug, name),
                    "count": len(by_city[slug])}
                   for slug, (name, _) in sorted(CITIES.items(), key=lambda c: -len(by_city.get(c[0], [])))
                   if slug in by_city],
        "categories": [{"slug": slug, "name": name, "name_kk": i18n.CATEGORIES_KK.get(slug, name)}
                       for slug, name in CATEGORIES.items()],
        "roles": roles(vacancies),
    }
    (folder / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), "utf-8")


def write_roles(folder: Path, items: list[Vacancy], base_url: str, now: datetime, venues: dict) -> None:
    """Файлы профессий города: только тех, чьи вакансии не все поместились в ленту города."""
    known = {title for _, title, _ in PROFESSIONS}
    beyond = {part for v in items[PER_CITY:] for part in v.title.split(", ") if part in known}
    by_role: dict[str, list[Vacancy]] = {}
    for v in items:
        for part in v.title.split(", "):
            if part in beyond:
                by_role.setdefault(part, []).append(v)
    if by_role:
        folder.mkdir(parents=True, exist_ok=True)
    for title, vs in by_role.items():
        payload = {"role": title, "vacancies": [item(v, base_url, now, venues) for v in vs[:PER_ROLE]]}
        (folder / f"{role_key(title)}.json").write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")), "utf-8")

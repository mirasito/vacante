"""Вакансии из рубрики «Работа» OLX.kz через публичный JSON сайта (/api/v1/offers/).

Решение Мираса (2026-11-05): брать вакансии OLX без отдельного разрешения OLX, риск по их правилам он берёт
на себя. Поэтому источник ведёт себя как честный робот и ничего не обходит:
- представляется своим User-Agent со ссылкой на vacante.kz, без подделки браузера, прокси и куки;
- ходит только по путям, которые robots.txt OLX.kz разрешает (/api/v1/offers/ и /api/v1/categories/);
- не чаще одного запроса в PAUSE секунд и не больше MAX_PAGES страниц за запуск;
- если OLX отвечает 403/429, капчей или не JSON, источник молча пропускает запуск и не пытается обойти защиту.
С серверов GitHub OLX отвечает 403, поэтому по решению Мираса запросы идут с его сервера в Казахстане
(OLX_VIA, server/src/olx.ts): тот же User-Agent, один адрес, без подделки и смены адресов.

Берём только саму вакансию: название, текст без телефонов и ссылок (parse.clean_text), зарплату, город, точку
на карте, если OLX показывает её точно, и ссылку на объявление на OLX.kz, где человек и откликается.
Имя автора, телефон и прочие контакты не запрашиваем и не храним.
"""

from __future__ import annotations

import hashlib
import hmac
import html
import logging
import os
import re
import time
from collections.abc import Callable
from datetime import datetime, timedelta, timezone

import httpx

from vacante.geo import city_point
from vacante.models import RawPost, Vacancy
from vacante.parse import _LIMITS, detect_city, explain

log = logging.getLogger(__name__)

SOURCE = "olx"
BASE = "https://www.olx.kz"
USER_AGENT = "vacante.kz/1.0 (+https://vacante.kz; job aggregator, links back to olx.kz)"
LIMIT = 50  # объявлений на страницу
MAX_PAGES = 20  # не больше 1000 объявлений за запуск: глубже OLX выдачу и не отдаёт
PAUSE = 3.0  # секунд между запросами
FIRST_RUN = timedelta(days=3)
OVERLAP = timedelta(hours=1)
PERIODS = {"monthly": "month", "month": "month", "daily": "day", "day": "day", "hourly": "hour", "hour": "hour"}
_TAG = re.compile(r"<[^>]+>")
_BR = re.compile(r"<\s*(?:br|/p|/li|/div)\s*/?\s*>", re.I)


class Blocked(Exception):
    """OLX не отдал данные роботу (403, 429, капча, не JSON). Обходить это мы не будем."""


def enabled() -> bool:
    return os.environ.get("OLX_SOURCE_ENABLED", "").strip().lower() in ("1", "true", "yes")


def make_client() -> httpx.Client:
    """Прямо к OLX или, если задан OLX_VIA (https://api.vacante.kz), через свой сервер в Казахстане:
    он берёт страницы OLX сам, тем же честным User-Agent (server/src/olx.ts). Ключ — как у бота к серверу,
    HMAC от токена бота, отдельный секрет не нужен."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    via = os.environ.get("OLX_VIA", "").strip().rstrip("/")
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if via and token:
        key = hmac.new(token.encode(), b"vacante-server-internal", hashlib.sha256).hexdigest()
        headers["Authorization"] = f"Bearer {key}"
        return httpx.Client(base_url=f"{via}/internal/olx", timeout=60, follow_redirects=False, headers=headers)
    return httpx.Client(base_url=BASE, timeout=30, follow_redirects=False, headers=headers)


def get(client: httpx.Client, path: str, params: dict | None = None,
        sleep: Callable[[float], None] = time.sleep) -> dict:
    sleep(PAUSE)
    r = client.get(path, params=params)
    if r.status_code == 200 and "x-olx-status" in r.headers:  # ответ через свой сервер: статус самого OLX
        status = int(r.headers["x-olx-status"])
        if status in (401, 403, 429, 451) or 300 <= status < 400:
            raise Blocked(f"HTTP {status} (через сервер vacante)")
        if status != 200:
            raise httpx.HTTPStatusError(f"OLX ответил {status}", request=r.request, response=r)
    elif r.status_code in (401, 403, 429, 451) or 300 <= r.status_code < 400:
        raise Blocked(f"HTTP {r.status_code}")
    r.raise_for_status()
    try:
        data = r.json()
    except ValueError:
        raise Blocked("ответ не JSON (похоже на капчу или страницу защиты)") from None
    if not isinstance(data, dict):
        raise Blocked("неожиданный формат ответа")
    return data


def job_category(client: httpx.Client, sleep: Callable[[float], None] = time.sleep) -> int | None:
    """id рубрики «Работа»: OLX_CATEGORY_ID или верхняя рубрика с типом job из /api/v1/categories/."""
    if (env := os.environ.get("OLX_CATEGORY_ID", "").strip()).isdigit():
        return int(env)
    for c in get(client, "/api/v1/categories/", None, sleep).get("data") or []:
        if not isinstance(c, dict) or c.get("parent_id") not in (0, None):
            continue
        name = str(c.get("name") or "").lower()
        code = str(c.get("code") or c.get("normalized_name") or "").lower()
        if c.get("type") == "job" or code == "rabota" or name in ("работа", "жұмыс"):
            return int(c["id"])
    return None


def _time(value: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat(value).astimezone(timezone.utc) if value else None
    except ValueError:
        return None


def search(client: httpx.Client, category: int, since: datetime,
           sleep: Callable[[float], None] = time.sleep) -> list[dict]:
    """Объявления рубрики от новых к старым, пока не дойдём до since."""
    items: list[dict] = []
    for page in range(MAX_PAGES):
        data = get(client, "/api/v1/offers/", {"category_id": category, "offset": page * LIMIT, "limit": LIMIT,
                                               "sort_by": "created_at:desc"}, sleep)
        batch = [x for x in data.get("data") or [] if isinstance(x, dict)]
        items += batch
        times = [t for t in (_time(x.get("created_time")) for x in batch) if t]
        if len(batch) < LIMIT or (times and min(times) < since):
            break
    return items


def _text(item: dict) -> str:
    raw = _BR.sub("\n", item.get("description") or "")
    return html.unescape(_TAG.sub("", raw)).strip()


def _param(item: dict, key: str) -> dict | None:
    for p in item.get("params") or []:
        if isinstance(p, dict) and p.get("key") == key and isinstance(p.get("value"), dict):
            return p["value"]
    return None


def _salary(item: dict) -> tuple[int | None, int | None, str | None]:
    s = _param(item, "salary")
    if not s or (s.get("currency") or "KZT").upper() != "KZT" or s.get("arranged"):
        return None, None, None
    period = PERIODS.get(str(s.get("type") or "monthly").lower())
    if period is None:
        return None, None, None
    lo, hi = _LIMITS[period]
    low, high = (int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and lo <= v <= hi else None
                 for v in (s.get("from"), s.get("to")))
    if low is None and high is None:
        return None, None, None
    return low, high, period


def to_vacancy(item: dict) -> Vacancy | None:
    """Вакансия или None, если объявление не для vacante.kz (резюме, офис, другая страна, не рабочая профессия)."""
    if item.get("offer_type") == "seek" or not item.get("id") or not str(item.get("url") or "").startswith(BASE):
        return None
    title = (item.get("title") or "").strip()
    posted = _time(item.get("created_time")) or _time(item.get("last_refresh_time"))
    if not title or posted is None:
        return None
    location = item.get("location") or {}
    city_name = ((location.get("city") or {}).get("name") or "").strip()
    city = detect_city(city_name, None) if city_name else None
    # Тот же разбор, что у постов из каналов: профессия, график, льготы, отсев офиса, резюме и работы за границей
    post = RawPost(SOURCE, SOURCE, int(item["id"]), item["url"], f"{title}\n{_text(item)}", posted, city)
    vacancy, _ = explain(post)
    if vacancy is None or (city_name and city is None):
        return None  # город OLX нам неизвестен или объявление не вакансия рабочей профессии
    vacancy.id = f"{SOURCE}-{item['id']}"
    vacancy.city = city or vacancy.city
    salary = _salary(item)
    if salary[2] is not None:
        vacancy.salary_min, vacancy.salary_max, vacancy.salary_period = salary
    m = item.get("map") or {}
    if m.get("show_detailed") and (point := city_point(vacancy.city, m.get("lat"), m.get("lon"))):
        vacancy.lat, vacancy.lon, vacancy.geo = point[0], point[1], SOURCE
    return vacancy


def collect(state: dict, now: datetime, client: httpx.Client | None = None,
            sleep: Callable[[float], None] = time.sleep) -> list[Vacancy] | None:
    """Новые вакансии OLX с прошлого запуска. None, если источник выключен или OLX не отдал данные."""
    if not enabled():
        return None
    own = client is None
    client = client or make_client()
    last = state.get("olx_checked_at")
    since = datetime.fromisoformat(last) - OVERLAP if last else now - FIRST_RUN
    try:
        category = job_category(client, sleep)
        if category is None:
            log.warning("olx: не нашли рубрику «Работа» в /api/v1/categories/, задайте OLX_CATEGORY_ID")
            state["olx_status"] = "no_category"
            return None
        items = search(client, category, since, sleep)
    except Blocked as exc:
        log.warning("olx: OLX не отдаёт данные роботу (%s). Защиту не обходим, источник пропускает запуск", exc)
        state["olx_status"] = f"blocked: {exc}"
        return None
    except httpx.HTTPError as exc:
        log.warning("olx: %s, источник пропускает этот запуск", exc if isinstance(exc, httpx.HTTPStatusError)
                    else type(exc).__name__)
        state["olx_status"] = f"error: {type(exc).__name__}"
        return None
    finally:
        if own:
            client.close()
    state["olx_checked_at"] = now.isoformat()
    state["olx_status"] = "ok"
    vacancies = {v.id: v for v in map(to_vacancy, items) if v is not None}
    log.info("olx: %s объявлений в выдаче, %s подходят", len(items), len(vacancies))
    return list(vacancies.values())

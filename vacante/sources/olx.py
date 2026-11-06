"""Автосбор открытых страниц рубрики «Работа»; старый API доступен через OLX_SOURCE_MODE=api."""

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
IMPORTS_FIRST = timedelta(days=14)  # при первом запуске берём всё, что забрано закладкой за две недели
OVERLAP = timedelta(hours=1)
PERIODS = {"monthly": "month", "month": "month", "daily": "day", "day": "day", "hourly": "hour", "hour": "hour"}
_TAG = re.compile(r"<[^>]+>")
_BR = re.compile(r"<\s*(?:br|/p|/li|/div)\s*/?\s*>", re.I)


class Blocked(Exception):
    """OLX не отдал данные роботу (403, 429, капча, не JSON). Обходить это мы не будем."""


def enabled() -> bool:
    return os.environ.get("OLX_SOURCE_ENABLED", "").strip().lower() in ("1", "true", "yes")


def via_server() -> bool:
    """Запросы идут через свой сервер (OLX_VIA): тогда у него же забираем объявления из браузера Мираса."""
    return bool(os.environ.get("OLX_VIA", "").strip() and os.environ.get("TELEGRAM_BOT_TOKEN", "").strip())


def make_client() -> httpx.Client:
    """Прямо к OLX или, если задан OLX_VIA (https://api.vacante.kz), через свой сервер в Казахстане:
    он берёт страницы OLX сам, тем же честным User-Agent (server/src/olx.ts). Ключ — как у бота к серверу,
    HMAC от токена бота, отдельный секрет не нужен."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    via = os.environ.get("OLX_VIA", "").strip().rstrip("/")
    if via_server():
        key = hmac.new(os.environ["TELEGRAM_BOT_TOKEN"].strip().encode(), b"vacante-server-internal",
                       hashlib.sha256).hexdigest()
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


def imports(client: httpx.Client, since: datetime, sleep: Callable[[float], None] = time.sleep) -> list[dict]:
    """Объявления, которые Мирас забрал из OLX в своём браузере закладкой «Забрать в vacante» после since.
    Сервер (server/src/olx-import.ts) отдаёт их в формате выдачи OLX, так что разбор общий (to_vacancy)."""
    data = get(client, "/imports", {"since": since.isoformat(timespec="seconds")}, sleep)
    return [x for x in data.get("data") or [] if isinstance(x, dict)]


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
    vacancy.contact = ["phone"] if item.get("has_phone") is True else []
    vacancy.city = city or vacancy.city
    salary = _salary(item)
    if salary[2] is not None:
        vacancy.salary_min, vacancy.salary_max, vacancy.salary_period = salary
    m = item.get("map") or {}
    if m.get("show_detailed") and (point := city_point(vacancy.city, m.get("lat"), m.get("lon"))):
        vacancy.lat, vacancy.lon, vacancy.geo = point[0], point[1], SOURCE
    return vacancy


def collect_api(state: dict, now: datetime, client: httpx.Client | None = None,
            sleep: Callable[[float], None] = time.sleep) -> list[Vacancy] | None:
    """Новые вакансии OLX с прошлого запуска: из выдачи OLX (пока OLX отвечает роботу 403, ничего) и из
    объявлений, которые Мирас забрал в браузере (только через свой сервер, OLX_VIA).
    None, если источник выключен или ни один из путей не дал ответа."""
    if not enabled():
        return None
    own = client is None
    client = client or make_client()
    items: list[dict] = []
    answered = False
    try:
        last = state.get("olx_checked_at")
        since = datetime.fromisoformat(last) - OVERLAP if last else now - FIRST_RUN
        try:
            category = job_category(client, sleep)
            if category is None:
                log.warning("olx: не нашли рубрику «Работа» в /api/v1/categories/, задайте OLX_CATEGORY_ID")
                state["olx_status"] = "no_category"
            else:
                items += search(client, category, since, sleep)
                state["olx_checked_at"] = now.isoformat()
                state["olx_status"] = "ok"
                answered = True
        except Blocked as exc:
            log.warning("olx: OLX не отдаёт данные роботу (%s). Защиту не обходим, выдачу пропускаем", exc)
            state["olx_status"] = f"blocked: {exc}"
        except httpx.HTTPError as exc:
            log.warning("olx: %s, выдачу пропускаем", exc if isinstance(exc, httpx.HTTPStatusError)
                        else type(exc).__name__)
            state["olx_status"] = f"error: {type(exc).__name__}"
        if via_server():
            last = state.get("olx_imports_at")
            since = datetime.fromisoformat(last) - OVERLAP if last else now - IMPORTS_FIRST
            try:
                imported = imports(client, since, sleep)
            except (Blocked, httpx.HTTPError) as exc:
                log.warning("olx: объявления из браузера с сервера не получены (%s)", exc)
            else:
                items += imported
                state["olx_imports_at"] = now.isoformat()
                answered = True
                log.info("olx: %s объявлений забрано закладкой с %s", len(imported), since.isoformat(timespec="minutes"))
    finally:
        if own:
            client.close()
    if not answered:
        return None
    vacancies = {v.id: v for v in map(to_vacancy, items) if v is not None}
    log.info("olx: %s объявлений, %s подходят", len(items), len(vacancies))
    return list(vacancies.values())

def collect(state: dict, now: datetime) -> list[Vacancy] | None:
    if not enabled():
        return None
    if os.environ.get("OLX_SOURCE_MODE") == "api":
        return collect_api(state, now)
    from vacante.sources.olx_web import collect_web
    # Авторизация Vacante используется только для записи на наш сервер.
    with httpx.Client(headers={"User-Agent": USER_AGENT, "Accept": "text/html"}, timeout=30) as public:
        if via_server():
            with make_client() as private:
                return collect_web(state, now, public, private)
        return collect_web(state, now, public, None)

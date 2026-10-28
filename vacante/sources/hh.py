"""Вакансии hh.kz через официальный API hh (api.hh.ru обслуживает и hh.kz).

Источник выключен, пока не задана переменная HH_SOURCE_ENABLED=true: включаем, когда hh одобрит
приложение vacante.kz. Токен приложения берётся из секрета HH_TOKEN, а если его нет, получается при каждом
запуске по секретам HH_CLIENT_ID и HH_CLIENT_SECRET приложения с dev.hh.ru. Без них запросы идут анонимно.
Если hh отвечает 403, источник пропускает этот запуск с понятным логом, остальной сбор идёт как обычно.

Берём из поисковой выдачи только саму вакансию: название, компанию, зарплату, город, адрес, короткое
описание и ссылку на hh.kz. Карточку вакансии с контактами рекрутера не запрашиваем и контакты не храним.
"""

from __future__ import annotations

import html
import logging
import os
import re
import time
from collections.abc import Callable
from datetime import datetime, timedelta, timezone

import httpx

from vacante.models import Vacancy
from vacante.parse import (CITIES, WHITE_COLLAR, _LIMITS, clean_text, detect_city, detect_titles, fingerprint,
                           parse_perks)

log = logging.getLogger(__name__)

SOURCE = "hh"
API = "https://api.hh.ru"
AREA = "40"  # весь Казахстан
PER_PAGE = 100
DEPTH = 2000  # больше 2000 результатов на один запрос API не отдаёт: такие окна делим по дате
MIN_WINDOW = timedelta(minutes=30)
PAUSE = 0.35  # секунд между запросами
RETRIES = 5
FIRST_RUN = timedelta(days=3)  # при первом запуске берём вакансии за последние три дня
OVERLAP = timedelta(hours=1)  # окно следующего запуска начинается чуть раньше, чтобы ничего не потерять
USER_AGENT = "vacante.kz/1.0 (+https://vacante.kz)"
PERIODS = {"MONTH": "month", "SHIFT": "day", "HOUR": "hour"}
_TAG = re.compile(r"<[^>]+>")


class TokenError(Exception):
    """hh не выдал токен приложения: неверные Client Id или Client Secret."""


class Forbidden(Exception):
    """hh ответил 403: нет доступа для нашего приложения или анонимного клиента."""


def enabled() -> bool:
    return os.environ.get("HH_SOURCE_ENABLED", "").strip().lower() in ("1", "true", "yes")


def app_token(client_id: str, client_secret: str, user_agent: str | None = None,
              transport: httpx.BaseTransport | None = None) -> str:
    """Токен приложения hh по Client Id и Client Secret (grant_type=client_credentials)."""
    agent = user_agent or USER_AGENT
    with httpx.Client(base_url=API, transport=transport, timeout=30,
                      headers={"User-Agent": agent, "HH-User-Agent": agent}) as http:
        r = http.post("/token", data={"grant_type": "client_credentials",
                                      "client_id": client_id, "client_secret": client_secret})
    if r.status_code != 200:
        try:
            error = r.json().get("error_description") or r.json().get("error") or ""
        except ValueError:
            error = ""
        raise TokenError(f"hh не выдал токен приложения: {r.status_code} {error}".strip())
    return r.json()["access_token"]


def token_from_env(transport: httpx.BaseTransport | None = None) -> str | None:
    """HH_TOKEN, иначе токен по HH_CLIENT_ID и HH_CLIENT_SECRET, иначе None (анонимные запросы)."""
    if token := os.environ.get("HH_TOKEN", "").strip():
        return token
    client_id = os.environ.get("HH_CLIENT_ID", "").strip()
    client_secret = os.environ.get("HH_CLIENT_SECRET", "").strip()
    if client_id and client_secret:
        return app_token(client_id, client_secret, os.environ.get("HH_USER_AGENT") or None, transport)
    return None


def make_client(token: str | None = None, user_agent: str | None = None) -> httpx.Client:
    agent = user_agent or USER_AGENT
    headers = {"User-Agent": agent, "HH-User-Agent": agent}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return httpx.Client(base_url=API, headers=headers, timeout=30)


def get(client: httpx.Client, path: str, params: dict, sleep: Callable[[float], None] = time.sleep) -> dict:
    """GET с паузой и повторами на 429 и 5xx. 403 — Forbidden, остальное — httpx.HTTPStatusError."""
    for attempt in range(RETRIES):
        sleep(PAUSE)
        r = client.get(path, params=params)
        if r.status_code == 200:
            return r.json()
        if r.status_code == 403:
            raise Forbidden(r.text[:200])
        if r.status_code in (429, 500, 502, 503, 504) and attempt < RETRIES - 1:
            sleep(2 ** attempt * 2)
            continue
        r.raise_for_status()
    raise httpx.HTTPError("hh: повторы закончились")


def search(client: httpx.Client, date_from: datetime, date_to: datetime,
           sleep: Callable[[float], None] = time.sleep) -> list[dict]:
    """Все вакансии Казахстана за окно. Окно, где больше 2000 результатов, делится пополам по дате."""
    # host=hh.kz: ссылки alternate_url ведут на hh.kz, а не на hh.ru
    params = {"area": AREA, "host": "hh.kz", "order_by": "publication_time", "per_page": PER_PAGE, "page": 0,
              "date_from": date_from.isoformat(timespec="seconds"), "date_to": date_to.isoformat(timespec="seconds")}
    first = get(client, "/vacancies", params, sleep)
    found = first.get("found", 0)
    if found > DEPTH and date_to - date_from > MIN_WINDOW:
        middle = date_from + (date_to - date_from) / 2
        return search(client, date_from, middle, sleep) + search(client, middle, date_to, sleep)
    items = list(first.get("items", []))
    for page in range(1, first.get("pages", 1)):
        items += get(client, "/vacancies", dict(params, page=page), sleep).get("items", [])
    if found > DEPTH:
        log.warning("hh: в окне %s–%s %s вакансий, забрано %s", date_from, date_to, found, len(items))
    return items


def _salary(item: dict) -> tuple[int | None, int | None, str | None]:
    s = item.get("salary_range") or item.get("salary")
    if not s or s.get("currency") != "KZT":
        return None, None, None
    period = PERIODS.get(((s.get("mode") or {}).get("id") or "MONTH").upper())
    if period is None:  # вахта и прочее: оплату не с чем сравнить
        return None, None, None
    lo, hi = _LIMITS[period]
    low, high = (v if isinstance(v, int) and lo <= v <= hi else None for v in (s.get("from"), s.get("to")))
    if low is None and high is None:
        return None, None, None
    return low, high, period


def _text(item: dict) -> str:
    snippet = item.get("snippet") or {}
    parts = []
    for key, label in (("responsibility", "Обязанности"), ("requirement", "Требования")):
        if value := snippet.get(key):
            parts.append(f"{label}: {html.unescape(_TAG.sub('', value)).strip()}")
    return clean_text("\n".join(parts))


def _address(item: dict, city: str) -> str | None:
    raw = ((item.get("address") or {}).get("raw") or "").strip()
    name = CITIES[city][0]
    if raw.lower().startswith(name.lower()):
        raw = raw[len(name):].lstrip(" ,")
    return raw or None


def to_vacancy(item: dict) -> Vacancy | None:
    """Вакансия из поисковой выдачи или None, если она не для vacante.kz (офис, другой город, не рабочая)."""
    name = (item.get("name") or "").strip()
    titles = detect_titles(name)
    if not name or not titles or WHITE_COLLAR.search(name.lower()):
        return None
    city = detect_city((item.get("area") or {}).get("name") or "", None)
    if city is None:
        return None
    salary_min, salary_max, period = _salary(item)
    schedule = ((item.get("schedule") or {}).get("name") or "").strip() or None
    text = _text(item) or name
    published = datetime.fromisoformat(item["published_at"]).astimezone(timezone.utc)
    return Vacancy(
        id=f"{SOURCE}-{item['id']}",
        title=name[:1].upper() + name[1:],
        category=titles[0][1],
        city=city,
        salary_min=salary_min,
        salary_max=salary_max,
        salary_period=period,
        schedule=schedule,
        perks=parse_perks(f"{name}\n{text}"),
        employer=((item.get("employer") or {}).get("name") or "").strip() or None,
        text=text,
        source=SOURCE,
        source_url=item["alternate_url"],
        posted_at=published.isoformat(),
        fingerprint=fingerprint(f"{name}\n{text}"),
        address=_address(item, city),
    )


def collect(state: dict, now: datetime, client: httpx.Client | None = None,
            sleep: Callable[[float], None] = time.sleep) -> list[Vacancy] | None:
    """Новые вакансии hh с прошлого запуска. None, если источник выключен или hh недоступен (403, сеть)."""
    if not enabled():
        return None
    own = client is None
    if own:
        try:
            token = token_from_env()
        except TokenError as exc:
            log.warning("%s. Проверьте секреты HH_CLIENT_ID и HH_CLIENT_SECRET, источник пропускает этот запуск", exc)
            return None
        except httpx.HTTPError as exc:
            log.warning("hh: токен приложения не получен (%s), источник пропускает этот запуск", type(exc).__name__)
            return None
        client = make_client(token, os.environ.get("HH_USER_AGENT") or None)
    last = state.get("hh_checked_at")
    date_from = datetime.fromisoformat(last) - OVERLAP if last else now - FIRST_RUN
    try:
        items = search(client, date_from, now, sleep)
    except Forbidden as exc:
        log.warning("hh: доступ запрещён (403), источник пропускает этот запуск. Проверьте секрет HH_TOKEN "
                    "и одобрение приложения на dev.hh.ru. Ответ hh: %s", exc)
        return None
    except httpx.HTTPError as exc:
        log.warning("hh: %s, источник пропускает этот запуск", exc if isinstance(exc, httpx.HTTPStatusError)
                    else type(exc).__name__)
        return None
    finally:
        if own:
            client.close()
    state["hh_checked_at"] = now.isoformat()
    vacancies = {v.id: v for v in map(to_vacancy, items) if v is not None}
    log.info("hh: %s вакансий в выдаче, %s подходят", len(items), len(vacancies))
    return list(vacancies.values())

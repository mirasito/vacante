"""Точки для вакансий без точки: адрес из объявления → точка на карте.

У большинства вакансий hh.kz точку ставит сам hh (vacante.sources.hh). Для остальных (из каналов, от
работодателей и с hh.kz без точки) адрес ищем в Nominatim, геокодере OpenStreetMap. Он бесплатный, а по его
правилам (operations.osmfoundation.org/policies/nominatim) запросы идут не чаще одного в секунду, с понятным
User-Agent, и ответы надо хранить у себя. Поэтому каждый адрес спрашиваем один раз и кладём ответ в кеш
geocode.json в ветке data, ненайденный адрес спрашиваем снова не раньше чем через месяц, а за один прогон сбора
делаем не больше GEOCODE_LIMIT запросов (по умолчанию LIMIT, 0 выключает запросы; разово больше — поле
geocode_limit при ручном запуске «Обновления вакансий»). Данные OpenStreetMap под лицензией ODbL: приложение
пишет «© OpenStreetMap» рядом с расстоянием.

Берём только точный ответ: дом, здание, заведение или небольшой микрорайон (рамка ответа не больше 1,5 км
по диагонали) и не дальше 50 км от центра города вакансии. Адрес без номера дома и без ТЦ, БЦ или ЖК
(«Есильский район») не ищем: точки у такого адреса нет.
"""

from __future__ import annotations

import json
import logging
import os
import re
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
MAX_BOX_KM = 1.5
BOX = (0.3, 0.45)  # окно поиска вокруг центра города: ±0,3° широты и ±0,45° долготы, около 35 км
RETRY_AFTER = 5.0  # секунд до повтора запроса, на который Nominatim не ответил (таймаут, обрыв, 5xx)
MAX_FAILURES = 3  # столько адресов подряд без ответа и после повтора: Nominatim нездоров, хватит на этот прогон
_PARENS = re.compile(r"\s*\([^)]*\)?|…")
_SPACES = re.compile(r"\s+")


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


def load(data_dir: Path) -> dict[str, dict]:
    path = data_dir / FILE
    return json.loads(path.read_text("utf-8")) if path.exists() else {}


def save(data_dir: Path, cache: dict[str, dict]) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(dict(sorted(cache.items())), ensure_ascii=False, indent=0)
    (data_dir / FILE).write_text(payload + "\n", "utf-8")


def lookup(client: httpx.Client, q: str, city: str, sleep: Callable[[float], None] = time.sleep
           ) -> tuple[float, float] | None:
    """Точка адреса или None, если Nominatim не знает его точно.

    Таймаут, обрыв или сбой сервера повторяем один раз, а не вышло — Skip: адрес спросим в следующий прогон.
    429 и 403 — Stop: дальше в этот прогон не спрашивать."""
    lat0, lon0 = CENTRES[city]
    dlat, dlon = BOX
    params = {"q": q, "format": "jsonv2", "limit": 1, "countrycodes": "kz", "accept-language": "ru",
              "viewbox": f"{lon0 - dlon},{lat0 + dlat},{lon0 + dlon},{lat0 - dlat}", "bounded": 1}
    failure = ""
    for wait in (PAUSE, RETRY_AFTER):
        sleep(wait)
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
            return None  # запрос Nominatim не понял (400 и т.п.): так адрес не найти
        try:
            found = r.json()
        except ValueError:
            failure = "ответ не JSON"
            continue
        break
    else:
        raise Skip(failure)
    if not isinstance(found, list) or not found or not isinstance(found[0], dict):
        return None
    try:
        lat, lon = float(found[0]["lat"]), float(found[0]["lon"])
        south, north, west, east = (float(x) for x in found[0]["boundingbox"])
    except (KeyError, TypeError, ValueError):
        return None
    if distance_km((south, west), (north, east)) > MAX_BOX_KM:
        return None  # улица целиком, район или весь город: где работа, не понять
    return city_point(city, lat, lon)


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
    stats = {"addresses": len(wanted), "cached": 0, "asked": 0, "found": 0, "failed": 0}
    own = client is None and limit > 0
    if own:
        client = httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=20)
    stopped = None
    failures = 0  # адресов подряд без ответа
    try:
        for key in order:
            q, city, items = wanted[key]
            entry = cache.get(key)
            if entry is not None and (entry.get("p") is not None or entry.get("at", "") >= retry_before):
                stats["cached"] += 1
            elif client is not None and stopped is None and stats["asked"] + stats["failed"] < limit:
                try:
                    point = lookup(client, q, city, sleep)
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
                entry = cache[key] = {"p": list(point) if point else None, "at": today}
            else:
                continue
            entry["used"] = today
            if entry.get("p"):
                stats["found"] += 1
                for v in items:
                    v.lat, v.lon = entry["p"]
                    v.geo = SOURCE
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
    text = (f"адресов {stats['addresses']}, из кеша {stats['cached']}, запросов {stats['asked']}, "
            f"с точкой {stats['found']}, без ответа {stats['failed']}")
    return text + (f"; остановлен: {stats['stopped']}" if stats.get("stopped") else "")

"""CRM работодателей на сервере api.vacante.kz (server/src/crm.ts): раз в час после сбора отправляем снимок.

Работодатель — название из вакансий без города, регистра и формы собственности («ТОО Greenwich» и «Greenwich»
в Алматы и Астане — один работодатель). Внутри него заведения: тот же ключ «город:название», что в venues.json,
с адресом из вакансий и ссылками, которые нашёл агент «Заведения». У заведения его вакансии с сайта.
Сервер сам отправляет в архив вакансии, которых нет в новом снимке.

Только открытые данные: контактов людей здесь нет. Ключ к серверу — HMAC от токена бота, как у OLX.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import httpx

from vacante import venues as venue_links
from vacante.models import Vacancy
from vacante.site.build import salary_label

log = logging.getLogger(__name__)

API = "https://api.vacante.kz"
CHUNK = 300  # работодателей в одном запросе


def employer_key(venue_key: str) -> str:
    return venue_key.split(":", 1)[1]


def snapshot(data_dir: Path, vacancies: list[Vacancy]) -> list[dict]:
    """Работодатели с заведениями и вакансиями, которые сейчас на сайте."""
    table = venue_links.load(data_dir)
    by_venue: dict[str, list[Vacancy]] = defaultdict(list)
    for v in vacancies:
        if v.employer:
            k = venue_links.key(v.employer, v.city)
            if employer_key(k):
                by_venue[k].append(v)

    employers: dict[str, dict] = {}
    names: dict[str, Counter] = defaultdict(Counter)
    for k, items in by_venue.items():
        items.sort(key=lambda v: v.posted_at, reverse=True)
        name = Counter(v.employer for v in items).most_common(1)[0][0]
        info = table.get(k) or {}
        addresses = Counter(v.address for v in items if v.address)
        point = next((v for v in items if v.lat is not None and v.lon is not None and not v.approx), None)
        venue = {
            "key": k, "name": name, "city": items[0].city,
            "address": addresses.most_common(1)[0][0] if addresses else None,
            "lat": point.lat if point else None, "lon": point.lon if point else None,
            "instagram": info.get("instagram"), "telegram": info.get("telegram"), "website": info.get("website"),
            "avatar": info.get("avatar"), "twogis": venue_links.twogis_search(name, items[0].city),
            "agent_status": info.get("status"),
            "vacancies": [{
                "id": v.id, "title": v.title, "category": v.category, "salary": salary_label(v),
                "source": v.source, "posted_at": v.posted_at, "top_until": v.top_until,
            } for v in items],
        }
        ek = employer_key(k)
        names[ek][name] += len(items)
        employers.setdefault(ek, {"key": ek, "venues": []})["venues"].append(venue)
    for ek, e in employers.items():
        e["name"] = names[ek].most_common(1)[0][0]
    return list(employers.values())


def internal_key(bot_token: str) -> str:
    return hmac.new(bot_token.strip().encode(), b"vacante-server-internal", hashlib.sha256).hexdigest()


def send(client: httpx.Client, employers: list[dict], now: datetime) -> dict:
    run_at = now.astimezone(timezone.utc).isoformat(timespec="seconds")
    sent = {"employers": 0, "venues": 0, "vacancies": 0}
    for i in range(0, len(employers), CHUNK):
        r = client.post("/internal/crm/import", json={"run_at": run_at, "employers": employers[i:i + CHUNK]})
        r.raise_for_status()
        for k, n in r.json().items():
            sent[k] = sent.get(k, 0) + n
    # Архивируем только после того, как дошёл весь снимок: иначе обрыв посередине снял бы живые вакансии
    r = client.post("/internal/crm/finish", json={"run_at": run_at})
    r.raise_for_status()
    return {"sent": sent, **r.json()}


def run(data_dir: Path, vacancies: list[Vacancy], now: datetime | None = None) -> dict | None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        log.info("CRM: нет TELEGRAM_BOT_TOKEN, пропускаю")
        return None
    base = (os.environ.get("CRM_VIA", "").strip() or API).rstrip("/")
    employers = snapshot(data_dir, vacancies)
    with httpx.Client(base_url=base, timeout=120, follow_redirects=False,
                      headers={"Authorization": f"Bearer {internal_key(token)}",
                               "User-Agent": "vacante.kz/1.0 (+https://vacante.kz)"}) as client:
        return send(client, employers, now or datetime.now(timezone.utc))

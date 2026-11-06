"""CRM работодателей на сервере api.vacante.kz (server/src/crm.ts): раз в час после сбора отправляем снимок.

Работодатель — название из вакансий без города, регистра и формы собственности («ТОО Greenwich» и «Greenwich»
в Алматы и Астане — один работодатель). Внутри него заведения: тот же ключ «город:название», что в venues.json,
с адресом из вакансий и ссылками, которые нашёл агент «Заведения». У заведения его вакансии с сайта.
Сервер сам отправляет в архив вакансии, которых нет в новом снимке.

Из базы бота (Cloudflare D1), если есть ключ Cloudflare: кто разместил вакансии в боте (сервер делает ему
профиль работодателя и спрашивает, для какого заведения вакансия), оплаты размещения и «Срочно» для выручки
по работодателям и статусы старой «CRM заведений». Это уходит только на сервер в Казахстане, не в ветку data.
С открытого API hh: логотип, сайт и описание компании для работодателей с вакансиями на hh.

Ключ к серверу — HMAC от токена бота, как у OLX.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import re

import httpx

from vacante import venues as venue_links
from vacante.sources import hh
from vacante.models import Vacancy
from vacante.site.build import salary_label

log = logging.getLogger(__name__)

API = "https://api.vacante.kz"
CHUNK = 300  # работодателей в одном запросе
HH_PER_RUN = 40  # карточек компаний с hh за запуск


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
    hh_ids: dict[str, Counter] = defaultdict(Counter)
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
        hh_ids[ek].update(v.employer_hh for v in items if v.employer_hh)
        employers.setdefault(ek, {"key": ek, "venues": []})["venues"].append(venue)
    for ek, e in employers.items():
        e["name"] = names[ek].most_common(1)[0][0]
        e["hh_id"] = hh_ids[ek].most_common(1)[0][0] if hh_ids[ek] else None
    return list(employers.values())


def _keys(company: str | None, city: str | None) -> dict:
    if not company or not company.strip():
        return {"venue_key": None, "employer_key": None}
    k = venue_links.key(company, city)
    return {"venue_key": k, "employer_key": employer_key(k) or None}


def from_bot(d1) -> dict:
    """Из базы бота: кто разместил одобренные вакансии, оплаты и статусы «CRM заведений»."""
    jobs = [{"job_id": r["id"], "chat": r["employer_chat"], "name": r.get("employer_name"),
             **_keys(r.get("company"), r.get("city"))}
            for r in d1.query("SELECT id, employer_chat, employer_name, company, city FROM jobs WHERE status = 'approved'")]
    payments = [{"id": r["id"], "job_id": r["job_id"], "kind": r.get("kind") or "boost", "amount": r["amount"],
                 "status": r["status"], "at": _utc(r.get("decided_at") or r.get("created_at")),
                 **_keys(r.get("company"), r.get("city"))}
                for r in d1.query("SELECT p.*, j.company, j.city FROM payments p LEFT JOIN jobs j ON j.id = p.job_id")]
    try:
        marks = {r["venue"]: {"status": r["status"], "note": r["note"], "contacted_at": _utc(r.get("contacted_at"))}
                 for r in d1.query("SELECT venue, status, note, contacted_at FROM crm")}
    except (httpx.HTTPError, RuntimeError):
        marks = {}
    return {"jobs": jobs, "payments": payments, "marks": marks}


def _utc(value: str | None) -> str | None:
    """«2026-11-01 13:27:32» из SQLite (это UTC) или ISO → ISO 8601 с зоной."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace(" ", "T"))
    except ValueError:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).isoformat(timespec="seconds")


def _plain(html: str | None, limit: int = 2000) -> str | None:
    if not html:
        return None
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"&nbsp;|&#160;", " ", text).replace("&amp;", "&").replace("&quot;", '"').replace("&laquo;", "«").replace("&raquo;", "»")
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit] or None


def hh_companies(client: httpx.Client, ids: list[str]) -> list[dict]:
    """Открытые карточки работодателей hh: логотип, сайт, описание. Контактов и рекрутеров тут нет."""
    out = []
    for i in ids[:HH_PER_RUN]:
        try:
            data = hh.get(client, f"/employers/{i}", {})
        except hh.Forbidden:
            log.warning("CRM: hh не отдал карточку работодателя (403), остальные в следующий раз")
            break
        except httpx.HTTPError:
            out.append({"id": i})  # нет такой карточки: отметим проверку, чтобы не спрашивать каждый час
            continue
        logos = data.get("logo_urls") or {}
        out.append({"id": i, "logo": logos.get("240") or logos.get("90") or logos.get("original"),
                    "site": data.get("site_url") or None, "about": _plain(data.get("description"))})
    return out


def internal_key(bot_token: str) -> str:
    return hmac.new(bot_token.strip().encode(), b"vacante-server-internal", hashlib.sha256).hexdigest()


def send(client: httpx.Client, employers: list[dict], now: datetime, extra: dict | None = None) -> dict:
    run_at = now.astimezone(timezone.utc).isoformat(timespec="seconds")
    sent = {"employers": 0, "venues": 0, "vacancies": 0}
    for i in range(0, len(employers), CHUNK):
        r = client.post("/internal/crm/import", json={"run_at": run_at, "employers": employers[i:i + CHUNK]})
        r.raise_for_status()
        for k, n in r.json().items():
            sent[k] = sent.get(k, 0) + n
    # Архивируем только после того, как дошёл весь снимок: иначе обрыв посередине снял бы живые вакансии
    r = client.post("/internal/crm/finish", json={"run_at": run_at, **(extra or {})})
    r.raise_for_status()
    return {"sent": sent, **r.json()}


def run(data_dir: Path, vacancies: list[Vacancy], now: datetime | None = None) -> dict | None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        log.info("CRM: нет TELEGRAM_BOT_TOKEN, пропускаю")
        return None
    base = (os.environ.get("CRM_VIA", "").strip() or API).rstrip("/")
    employers = snapshot(data_dir, vacancies)
    extra = {}
    account, cf_token = os.environ.get("CLOUDFLARE_ACCOUNT_ID"), os.environ.get("CLOUDFLARE_API_TOKEN")
    if account and cf_token:
        from vacante.digest import D1
        try:
            with httpx.Client(timeout=30) as http:
                d1 = D1(http, account, cf_token)
                if d1.database_id():
                    extra = from_bot(d1)
        except (httpx.HTTPError, RuntimeError) as exc:
            log.warning("CRM: база бота недоступна (%s), вакансии и оплаты из бота в следующий раз", type(exc).__name__)
    with httpx.Client(base_url=base, timeout=120, follow_redirects=False,
                      headers={"Authorization": f"Bearer {internal_key(token)}",
                               "User-Agent": "vacante.kz/1.0 (+https://vacante.kz)"}) as client:
        stats = send(client, employers, now or datetime.now(timezone.utc), extra)
        missing = stats.pop("hh_missing", []) or []
        stats["hh_missing"] = len(missing)
        if missing:
            try:
                hh_token = hh.token_from_env()
            except (hh.TokenError, httpx.HTTPError):
                hh_token = None
            with hh.make_client(hh_token, os.environ.get("HH_USER_AGENT") or None) as hh_client:
                companies = hh_companies(hh_client, missing)
            if companies:
                r = client.post("/internal/crm/hh", json={"employers": companies})
                r.raise_for_status()
                stats["hh"] = r.json().get("updated", 0)
        stats["bot_jobs"] = len(extra.get("jobs", []))
        stats["payments"] = len(extra.get("payments", []))
        return stats

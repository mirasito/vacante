"""Читает только объявления основной выдачи OLX. Никаких браузерных сессий."""
import json
import logging
import re
import time
from datetime import timedelta

import httpx

from vacante.sources import olx

log = logging.getLogger(__name__)
STATE = re.compile(r"window\.__PRERENDERED_STATE__\s*=\s*")
MAX_PAGES = 25
JOB = re.compile(r"https://www\.olx\.kz/(?:d/)?obyavlenie/rabota/[^/?#]+\.html")


def listing(page, number):
    marker = STATE.search(page)
    if not marker:
        raise ValueError("OLX не вернул разметку списка")
    data, _ = json.JSONDecoder().raw_decode(page, marker.end())
    if isinstance(data, str):
        data = json.loads(data)
    result = data["listing"]["listing"]
    if result["pageNumber"] != number - 1 or not isinstance(result["ads"], list):
        raise ValueError("Неожиданный номер или формат страницы OLX")
    return result


def parse_ad(ad, now):
    if not isinstance(ad, dict) or not ad.get("isJob") or ad.get("isActive") is False:
        return None
    url = ad.get("url") or ""
    if not JOB.fullmatch(url) or not isinstance(ad.get("id"), int) or not isinstance(ad.get("description"), str):
        return None
    created = olx._time(ad.get("createdTime"))
    if not created or not now - timedelta(days=14) <= created <= now:
        return None
    pay = ad.get("salary") or {}
    salary = {"from": pay.get("from"), "to": pay.get("to"), "type": pay.get("period"),
              "currency": pay.get("currencyCode"), "arranged": pay.get("negotiable")}
    city = (ad.get("location") or {}).get("cityName")
    row = {"id": ad["id"], "url": url, "title": ad.get("title"), "description": ad["description"],
           "created_time": created.isoformat(), "last_refresh_time": ad.get("lastRefreshTime"),
           "map": ad.get("map"), "salary": salary, "city": city}
    offer = {**row, "location": {"city": {"name": city}}, "params": [{"key": "salary", "value": salary}]}
    vacancy = olx.to_vacancy(offer)
    return (row, vacancy) if vacancy else None


def collect_web(state, now, public, private, sleep=time.sleep, max_pages=MAX_PAGES, *, via=False):
    found = {}
    pages = 0
    status = "ok"
    contacts_ok = private is not None
    for number in range(1, max_pages + 1):
        if number > 1:
            sleep(olx.PAUSE)
        try:
            response = public.get("listing" if via else olx.BASE + "/rabota/",
                                  params={"page": number} if number > 1 else {})
            response.raise_for_status()
            upstream = response.headers.get("x-olx-status", "200") if via else "200"
            if upstream != "200":
                status = f"HTTP {upstream}"
                log.warning("olx: сервер получил %s на странице %s", status, number)
                break
            data = listing(response.text, number)
            total = int(data["totalPages"])
        except (httpx.HTTPError, ValueError, TypeError, KeyError) as exc:
            status = f"HTTP {exc.response.status_code}" if isinstance(exc, httpx.HTTPStatusError) else type(exc).__name__
            log.warning("olx: остановка на странице %s (%s)", number, status)
            break
        pages += 1
        batch = []
        for ad in data["ads"]:
            item = parse_ad(ad, now)
            if item:
                row, vacancy = item
                if row["id"] not in found:
                    found[row["id"]] = vacancy
                    batch.append(row)
        if batch and contacts_ok:
            try:
                saved = private.post("batch", json={"items": batch})
                saved.raise_for_status()
                for ad_id in saved.json()["phone_ids"]:
                    if ad_id in found:
                        found[ad_id].contact = ["phone"]
            except (httpx.HTTPError, ValueError, TypeError, KeyError):
                log.warning("olx: сервер контактов недоступен, вакансии сохраняются со ссылкой на OLX")
                contacts_ok = False
        if number >= total or not data["ads"]:
            break
    state.update(olx_status=status, olx_pages=pages, olx_candidates=len(found), olx_contact_store_ok=contacts_ok)
    if pages and status == "ok":
        state["olx_checked_at"] = now.isoformat()
    log.info("olx: %s страниц, %s подходящих вакансий, статус %s", pages, len(found), status)
    return list(found.values()) if pages else None

"""Сообщить поисковикам о новых страницах сайта сразу после выкладки и читать Google Search Console.

  python -m vacante.searchping diff OLD_SITEMAP NEW_SITEMAP OUT   — адреса, которых не было в прошлой карте сайта
  python -m vacante.searchping send URLS_FILE                     — отправить их в IndexNow и Google Indexing API
  python -m vacante.searchping report [дней]                      — сводка Search Console и отправка карты сайта

IndexNow (Bing, а через него поиск ChatGPT, Яндекс, Seznam и др.) работает без регистрации: ключ публичный,
лежит файлом в корне сайта (INDEXNOW_KEY в vacante/site/build.py). Google Indexing API официально принимает
страницы с разметкой JobPosting, но нужен сервисный аккаунт Google: JSON-ключ в секрете GSC_SERVICE_ACCOUNT,
а почта аккаунта добавлена владельцем сайта в Search Console. Без секрета шаги Google пропускаются.
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
import time
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import quote, urlparse

import httpx

from vacante.site.build import INDEXNOW_KEY

SITE = os.environ.get("SITE_URL", "https://vacante.kz").rstrip("/")
# Бесплатная квота Indexing API — 200 адресов в сутки. Прогонов 24 в сутки, по 8 за прогон в неё укладываемся
GOOGLE_PER_RUN = int(os.environ.get("GOOGLE_PER_RUN", "8"))
INDEXNOW_MAX = 10_000  # больше за один запрос IndexNow не принимает
SCOPES = "https://www.googleapis.com/auth/indexing https://www.googleapis.com/auth/webmasters"


def sitemap_urls(xml: str) -> list[str]:
    return re.findall(r"<loc>([^<]+)</loc>", xml)


def new_urls(old_xml: str, new_xml: str) -> list[str]:
    """Адреса новой карты сайта, которых не было в старой, в порядке новой карты."""
    old = set(sitemap_urls(old_xml))
    return [u for u in sitemap_urls(new_xml) if u not in old]


def google_order(urls: list[str]) -> list[str]:
    """Для Google сначала свои вакансии: из Telegram и от работодателей. Копии hh.kz и OLX Google
    и так найдёт у первоисточника, на них квоту не тратим. Казахские версии — по hreflang из карты сайта."""
    vacancies = [u for u in urls if "/v/" in u and "/kk/" not in u]
    own = [u for u in vacancies if not re.search(r"/v/(hh|olx)-", u)]
    return own


def indexnow(client: httpx.Client, urls: list[str]) -> str:
    if not urls:
        return "IndexNow: новых адресов нет"
    host = urlparse(SITE).netloc
    r = client.post("https://api.indexnow.org/indexnow", json={
        "host": host, "key": INDEXNOW_KEY, "keyLocation": f"{SITE}/{INDEXNOW_KEY}.txt", "urlList": urls[:INDEXNOW_MAX]})
    # 200 и 202 — приняли; 422 — адреса не с этого сайта или ключ не совпал; 429 — слишком часто
    return f"IndexNow: {min(len(urls), INDEXNOW_MAX)} адресов, ответ {r.status_code}"


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def google_token(client: httpx.Client, account: dict) -> str:
    """Токен доступа сервисного аккаунта: JWT, подписанный его ключом (RS256)."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    now = int(time.time())
    head = _b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = _b64(json.dumps({"iss": account["client_email"], "scope": SCOPES, "aud": account["token_uri"],
                              "iat": now, "exp": now + 3600}).encode())
    key = serialization.load_pem_private_key(account["private_key"].encode(), password=None)
    signature = key.sign(f"{head}.{claims}".encode(), padding.PKCS1v15(), hashes.SHA256())
    r = client.post(account["token_uri"], data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                                                "assertion": f"{head}.{claims}.{_b64(signature)}"})
    r.raise_for_status()
    return r.json()["access_token"]


def service_account() -> dict | None:
    raw = os.environ.get("GSC_SERVICE_ACCOUNT", "").strip()
    return json.loads(raw) if raw else None


def google_index(client: httpx.Client, urls: list[str]) -> str:
    account = service_account()
    if not account:
        return "Google Indexing API: нет секрета GSC_SERVICE_ACCOUNT, пропускаю"
    picked = google_order(urls)[:GOOGLE_PER_RUN]
    if not picked:
        return "Google Indexing API: новых своих вакансий нет"
    auth = {"Authorization": f"Bearer {google_token(client, account)}"}
    codes = []
    for url in picked:
        r = client.post("https://indexing.googleapis.com/v3/urlNotifications:publish", headers=auth,
                        json={"url": url, "type": "URL_UPDATED"})
        codes.append(r.status_code)
        if r.status_code == 403:  # аккаунт не добавлен владельцем в Search Console
            return f"Google Indexing API: 403, добавьте {account['client_email']} владельцем в Search Console"
        if r.status_code == 429:  # квота на сутки кончилась
            break
    return f"Google Indexing API: {len(codes)} адресов, ответы {sorted(set(codes))}"


def send(path: Path) -> None:
    urls = [u for u in path.read_text("utf-8").split() if u]
    with httpx.Client(timeout=30) as client:
        for step in (indexnow, google_index):
            try:
                print(step(client, urls))
            except httpx.HTTPError as e:  # поисковик недоступен: сайт уже выложен, следующий прогон попробует снова
                print(f"{step.__name__}: ошибка {e}")


def _property(client: httpx.Client, auth: dict) -> str:
    """Ресурс сайта в Search Console: доменный (sc-domain:vacante.kz) или по адресу (https://vacante.kz/)."""
    r = client.get("https://searchconsole.googleapis.com/webmasters/v3/sites", headers=auth)
    r.raise_for_status()
    sites = [s["siteUrl"] for s in r.json().get("siteEntry", [])]
    host = urlparse(SITE).netloc
    for want in (f"sc-domain:{host}", f"{SITE}/", f"https://www.{host}/"):
        if want in sites:
            return want
    sys.exit(f"Сервисный аккаунт не видит {host} в Search Console. Видит: {sites or 'ничего'}. "
             "Добавьте его почту в Search Console → Настройки → Пользователи и разрешения.")


def report(days: int) -> None:
    account = service_account()
    if not account:
        sys.exit("Нет секрета GSC_SERVICE_ACCOUNT: шаги в шапке .github/workflows/seo.yml")
    with httpx.Client(timeout=60) as client:
        auth = {"Authorization": f"Bearer {google_token(client, account)}"}
        prop = _property(client, auth)
        base = f"https://searchconsole.googleapis.com/webmasters/v3/sites/{quote(prop, safe='')}"
        # Карта сайта: отправляем (повторная отправка безвредна) и показываем, что Google о ней знает
        sitemap = quote(f"{SITE}/sitemap.xml", safe="")
        put = client.put(f"{base}/sitemaps/{sitemap}", headers=auth)
        print(f"Ресурс {prop}. Карта сайта отправлена: ответ {put.status_code}")
        r = client.get(f"{base}/sitemaps", headers=auth)
        for s in r.json().get("sitemap", []):
            sent = sum(int(c.get("submitted", 0)) for c in s.get("contents", []))
            print(f"  {s['path']}: адресов {sent}, прочитана {s.get('lastDownloaded', '—')}, "
                  f"ошибок {s.get('errors', 0)}, предупреждений {s.get('warnings', 0)}")
        # Данные Search Console приходят с задержкой 2–3 дня
        end = date.today() - timedelta(days=2)
        start = end - timedelta(days=days)
        for title, dims, limit in [("по дням", ["date"], 100), ("запросы", ["query"], 40), ("страницы", ["page"], 25),
                                   ("страны", ["country"], 5), ("устройства", ["device"], 5),
                                   ("тип результата", ["searchAppearance"], 10)]:
            body = {"startDate": start.isoformat(), "endDate": end.isoformat(), "dimensions": dims, "rowLimit": limit}
            r = client.post(f"{base}/searchAnalytics/query", headers=auth, json=body)
            if r.status_code != 200:
                print(f"\n== {title}: ошибка {r.status_code} {r.text[:200]}")
                continue
            rows = r.json().get("rows", [])
            print(f"\n== {title} ({start} — {end}): клики, показы, CTR %, средняя позиция")
            if dims == ["date"]:
                rows.sort(key=lambda x: x["keys"][0])
            for row in rows:
                key = row["keys"][0].replace(SITE, "")
                print(f"{key[:70]:70} {row['clicks']:6.0f} {row['impressions']:8.0f} "
                      f"{row['ctr'] * 100:6.1f} {row['position']:6.1f}")
            if not rows:
                print("пока нет данных")


def main(argv: list[str]) -> None:
    if argv[:1] == ["diff"] and len(argv) == 4:
        old = Path(argv[1]).read_text("utf-8") if Path(argv[1]).exists() else ""
        urls = new_urls(old, Path(argv[2]).read_text("utf-8")) if old else []
        Path(argv[3]).write_text("\n".join(urls), "utf-8")
        print(f"новых адресов: {len(urls)}" if old else "прошлой карты сайта нет, отправлять нечего")
    elif argv[:1] == ["send"] and len(argv) == 2:
        send(Path(argv[1]))
    elif argv[:1] == ["report"]:
        report(int(argv[1]) if len(argv) > 1 else 28)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])

"""Сообщить поисковикам о новых страницах сайта сразу после выкладки и читать Google Search Console.

  python -m vacante.searchping diff OLD_SITEMAP NEW_SITEMAP OUT   — адреса, которых не было в прошлой карте сайта
  python -m vacante.searchping send URLS_FILE                     — отправить их в IndexNow и Google Indexing API
  python -m vacante.searchping report [дней]                      — сводка Search Console и отправка карты сайта
  python -m vacante.searchping inspect [страниц]                  — выборочная проверка: что из карты сайта в индексе Google

IndexNow (Bing, а через него поиск ChatGPT, Яндекс, Seznam и др.) работает без регистрации: ключ публичный,
лежит файлом в корне сайта (INDEXNOW_KEY в vacante/site/build.py). Google Indexing API официально принимает
страницы с разметкой JobPosting, но нужен сервисный аккаунт Google: JSON-ключ в секрете GSC_SERVICE_ACCOUNT,
а почта аккаунта добавлена владельцем сайта в Search Console. Без секрета шаги Google пропускаются.
"""

from __future__ import annotations

import base64
import json
import os
import random
import re
import sys
import threading
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
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


# Суточная квота URL Inspection API — 2000 адресов на ресурс, в минуту 600
INSPECT_MAX = 600
# Сколько запросов проверки идёт одновременно: квота 600 в минуту, один ответ занимает несколько секунд
INSPECT_WORKERS = 4
# Страница моложе стольких дней: Google мог до неё ещё не дойти, считаем отдельно
FRESH_DAYS = 3


def page_group(url: str) -> str:
    """Вид страницы для выборочной проверки индекса: копия hh, вакансия из канала, список города и т. д."""
    parts = [p for p in urlparse(url).path.split("/") if p]
    kk = parts[:1] == ["kk"]
    if kk:
        parts = parts[1:]
    if parts[:1] == ["v"] and len(parts) > 1:
        source = parts[1].split("-", 1)[0]
        kind = {"hh": "вакансия hh", "olx": "вакансия OLX"}.get(source, "вакансия из каналов и от работодателей")
    elif not parts:
        kind = "главная"
    elif len(parts) == 1:
        kind = "город или раздел"
    else:
        kind = "сфера, профессия или смены в городе"
    return kind + (" (kk)" if kk else "")


def sitemap_pages(xml: str) -> list[tuple[str, str]]:
    """[(адрес, дата изменения)] из карты сайта."""
    return re.findall(r"<loc>([^<]+)</loc>\s*<lastmod>([^<]+)</lastmod>", xml)


def inspect_sample(pages: list[tuple[str, str]], total: int, today: date, seed: str) -> list[tuple[str, str, bool]]:
    """Выборка для проверки: поровну на каждый вид страниц, внутри вида случайно, но одинаково за день.
    Возвращает [(вид, адрес, свежая)]: свежим страницам Google мог ещё не успеть."""
    groups: dict[str, list[tuple[str, bool]]] = defaultdict(list)
    for url, lastmod in pages:
        fresh = (today - date.fromisoformat(lastmod[:10])).days < FRESH_DAYS
        groups[page_group(url)].append((url, fresh))
    rng = random.Random(seed)
    picked = []
    left = total
    # От малых видов к большим: что не выбрали у главной и городов (их единицы), достаётся вакансиям
    for i, group in enumerate(sorted(groups, key=lambda g: (len(groups[g]), g))):
        items = sorted(groups[group])
        take = min(len(items), max(1, left // (len(groups) - i)))
        left -= take
        for url, fresh in rng.sample(items, take):
            picked.append((group, url, fresh))
    return picked


def _days_ago(stamp: str | None, now: datetime) -> float | None:
    if not stamp:
        return None
    return (now - datetime.fromisoformat(stamp.replace("Z", "+00:00"))).total_seconds() / 86400


def _inspect_one(client: httpx.Client, auth: dict, prop: str, url: str) -> tuple[int, dict | str]:
    """Один запрос URL Inspection API: (200, результат проверки) или (код ответа, начало текста ошибки).
    Сбой сети — код 0: одна неответившая страница не должна ронять весь отчёт."""
    try:
        r = client.post("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", headers=auth,
                        json={"inspectionUrl": url, "siteUrl": prop, "languageCode": "ru"})
    except httpx.HTTPError as exc:
        return 0, type(exc).__name__
    if r.status_code != 200:
        return r.status_code, r.text[:160]
    return 200, r.json().get("inspectionResult", {})


def inspect(total: int) -> None:
    """Что из карты сайта Google держит в индексе: URL Inspection API по выборке страниц каждого вида.
    Сводного числа «Проиндексировано» в API нет, оно только в интерфейсе Search Console."""
    account = service_account()
    if not account:
        sys.exit("Нет секрета GSC_SERVICE_ACCOUNT: шаги в шапке .github/workflows/seo.yml")
    total = max(1, min(total, INSPECT_MAX))
    now = datetime.now(timezone.utc)
    with httpx.Client(timeout=60) as client:
        pages = sitemap_pages(client.get(f"{SITE}/sitemap.xml", follow_redirects=True).text)
        if not pages:
            sys.exit(f"В {SITE}/sitemap.xml не нашлось адресов")
        sizes = Counter(page_group(url) for url, _ in pages)
        sample = inspect_sample(pages, total, now.date(), now.date().isoformat())
        auth = {"Authorization": f"Bearer {google_token(client, account)}"}
        prop = _property(client, auth)
        print(f"Ресурс {prop}. В карте сайта {len(pages)} адресов, проверяю {len(sample)}")
        rows = []  # (вид, свежая, адрес, ответ indexStatusResult, найденные виды разметки)
        stop = threading.Event()  # квота кончилась или доступ закрыт: оставшиеся адреса не спрашиваем

        def ask(item: tuple[str, str, bool]) -> tuple[int, dict | str] | None:
            return None if stop.is_set() else _inspect_one(client, auth, prop, item[1])

        # Один ответ Google идёт несколько секунд, поэтому спрашиваем в несколько потоков
        with ThreadPoolExecutor(INSPECT_WORKERS) as pool:
            for n, ((group, url, fresh), answer) in enumerate(zip(sample, pool.map(ask, sample)), 1):
                if n % 50 == 0:
                    print(f"  проверено {n} из {len(sample)}", flush=True)
                if answer is None:
                    continue
                code, result = answer
                if code == 429:
                    if not stop.is_set():
                        print("Квота на сегодня кончилась, считаю по тому, что успел")
                    stop.set()
                elif code != 200:
                    print(f"  {url.replace(SITE, '')}: ошибка {code or ''} {result}".rstrip())
                    if code in (401, 403):
                        stop.set()
                else:
                    rich = [i.get("richResultType", "") for i in result.get("richResultsResult", {}).get("detectedItems", [])]
                    rows.append((group, fresh, url, result.get("indexStatusResult", {}), rich))

    def indexed(status: dict) -> bool:
        return status.get("verdict") == "PASS"

    print("\n== по видам страниц: в карте сайта, проверено, в индексе, % (отдельно страницы старше "
          f"{FRESH_DAYS} дн.), оценка страниц в индексе")
    estimate = 0.0
    for group in sorted(sizes, key=lambda g: -sizes[g]):
        mine = [row for row in rows if row[0] == group]
        if not mine:
            print(f"{group[:44]:44} {sizes[group]:6} —")
            continue
        good = sum(indexed(row[3]) for row in mine)
        old = [row for row in mine if not row[1]]
        old_good = sum(indexed(row[3]) for row in old)
        share = good / len(mine)
        estimate += share * sizes[group]
        old_share = f"{old_good / len(old) * 100:5.0f}% из {len(old)}" if old else "    —"
        print(f"{group[:44]:44} {sizes[group]:6} {len(mine):5} {good:5} {share * 100:5.0f}%   старше: {old_share}"
              f"   ≈{share * sizes[group]:6.0f}")
    print(f"Оценка: в индексе около {estimate:.0f} из {len(pages)} страниц карты сайта "
          f"(выборка {len(rows)}, точность ±{100 / max(1, len(rows)) ** 0.5:.0f} п. п.)")

    print("\n== состояние по ответу Google (все проверенные): страниц")
    for state, n in Counter(row[3].get("coverageState", "—") for row in rows).most_common():
        print(f"{state[:90]:90} {n:5}")

    print("\n== состояние по видам страниц")
    for group in sorted(sizes, key=lambda g: -sizes[g]):
        states = Counter(row[3].get("coverageState", "—") for row in rows if row[0] == group)
        if states:
            print(f"{group}: " + "; ".join(f"{state} — {n}" for state, n in states.most_common()))

    print("\n== какую страницу Google считает главной (canonical), когда выбрал не нашу")
    other = [(row[2], row[3]) for row in rows
             if row[3].get("googleCanonical") and row[3].get("googleCanonical") != row[3].get("userCanonical", row[2])]
    print(f"не нашу выбрал у {len(other)} из {len(rows)}")
    for url, status in other[:25]:
        print(f"  {url.replace(SITE, '')[:60]:60} → {status['googleCanonical'].replace(SITE, '')[:70]}")

    print("\n== когда Google последний раз заходил на страницу (дней назад): вид, никогда, до 3, 3–14, больше 14")
    for group in sorted(sizes, key=lambda g: -sizes[g]):
        ages = [_days_ago(row[3].get("lastCrawlTime"), now) for row in rows if row[0] == group]
        if ages:
            known = [a for a in ages if a is not None]
            print(f"{group[:44]:44} {len(ages) - len(known):5} {sum(a < 3 for a in known):5} "
                  f"{sum(3 <= a <= 14 for a in known):5} {sum(a > 14 for a in known):5}")

    print("\n== разметка, которую Google увидел на страницах: вид разметки, страниц")
    for kind, n in Counter(k for row in rows for k in row[4]).most_common():
        print(f"{kind[:60]:60} {n:5}")
    with_jobs = sum(any("ваканс" in k.lower() or "job" in k.lower() for k in row[4]) for row in rows
                    if row[0].startswith("вакансия"))
    print(f"вакансий с разметкой объявления о работе: {with_jobs} из "
          f"{sum(row[0].startswith('вакансия') for row in rows)}")

    print("\n== прочее: как Google получил страницу, робот, запреты")
    for field in ("pageFetchState", "crawledAs", "robotsTxtState", "indexingState"):
        print(f"{field}: " + "; ".join(f"{k} — {n}" for k, n in Counter(row[3].get(field, "—") for row in rows).most_common()))


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
    elif argv[:1] == ["inspect"]:
        inspect(int(argv[1]) if len(argv) > 1 else 120)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])

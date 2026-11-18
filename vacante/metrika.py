"""Сводка Яндекс Метрики сайта для workflow «Метрика»: только числа, без адресов и идентификаторов посетителей.

Токен OAuth с правом «Получение статистики, чтение параметров своих и доверенных счётчиков» лежит
в секрете METRIKA_TOKEN. Номер счётчика — как на сайте (vacante/site/build.py).
"""
import os
import sys
from datetime import datetime, timedelta, timezone

import httpx

API = "https://api-metrika.yandex.net/stat/v1/data"
COUNTER = os.environ.get("METRIKA_COUNTER", "113822258")

REPORTS = [
    ("по дням: визиты, посетители, просмотры, доля роботов %, отказы %",
     {"dimensions": "ym:s:date", "metrics": "ym:s:visits,ym:s:users,ym:s:pageviews,ym:s:robotPercentage,ym:s:bounceRate",
      "sort": "ym:s:date"}),
    ("источники трафика",
     {"dimensions": "ym:s:lastTrafficSource", "metrics": "ym:s:visits,ym:s:users,ym:s:robotPercentage", "sort": "-ym:s:visits"}),
    ("сайты-источники (переходы по ссылкам, в том числе из Telegram)",
     {"dimensions": "ym:s:lastReferalSource", "metrics": "ym:s:visits,ym:s:users", "sort": "-ym:s:visits", "limit": 15}),
    ("поисковые системы",
     {"dimensions": "ym:s:lastSearchEngine", "metrics": "ym:s:visits,ym:s:users", "sort": "-ym:s:visits", "limit": 10}),
    ("метки utm_source (ссылки из своих каналов и бота)",
     {"dimensions": "ym:s:lastUTMSource", "metrics": "ym:s:visits,ym:s:users", "sort": "-ym:s:visits", "limit": 15}),
    ("устройства", {"dimensions": "ym:s:deviceCategory", "metrics": "ym:s:visits,ym:s:users", "sort": "-ym:s:visits"}),
    ("города", {"dimensions": "ym:s:regionCity", "metrics": "ym:s:visits,ym:s:users", "sort": "-ym:s:visits", "limit": 15}),
    ("самые посещаемые страницы",
     {"dimensions": "ym:pv:URLPath", "metrics": "ym:pv:pageviews,ym:pv:users", "sort": "-ym:pv:pageviews", "limit": 20}),
]


def fmt(value) -> str:
    if isinstance(value, float):
        return f"{value:.1f}" if value % 1 else str(int(value))
    return str(value)


def main() -> int:
    token = os.environ.get("METRIKA_TOKEN", "")
    if not token:
        print("::error::Нет секрета METRIKA_TOKEN: как его получить — в .github/workflows/metrika.yml")
        return 1
    days = int(os.environ.get("DAYS", "14"))
    date2 = datetime.now(timezone(timedelta(hours=5))).date()  # день по Казахстану
    date1 = date2 - timedelta(days=days - 1)
    print(f"Счётчик {COUNTER}, с {date1} по {date2}")
    failed = False
    with httpx.Client(timeout=30, headers={"Authorization": f"OAuth {token}"}) as client:
        for title, params in REPORTS:
            r = client.get(API, params={"ids": COUNTER, "date1": str(date1), "date2": str(date2),
                                        "accuracy": "full", "limit": 100, **params})
            print(f"\n--- {title}")
            if r.status_code != 200:
                try:
                    message = r.json().get("message", "")
                except ValueError:
                    message = ""
                print(f"    ошибка {r.status_code} {message}")
                failed = failed or r.status_code in (401, 403)
                continue
            body = r.json()
            for row in body.get("data", []):
                name = " / ".join(str(d.get("name") or "—") for d in row["dimensions"])
                print(f"    {name}: " + ", ".join(fmt(m) for m in row["metrics"]))
            print("    итого: " + ", ".join(fmt(m) for m in body.get("totals", [])))
    if failed:
        print("::error::Метрика не приняла токен: проверьте секрет METRIKA_TOKEN и доступ к счётчику")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

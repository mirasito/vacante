"""Сводка по подписчикам бота для workflow «Статистика»: только числа, без chat_id и имён.
База бота (Cloudflare D1) читается только SELECT-запросами."""
import os
import sys

import httpx

sys.path.insert(0, os.getcwd())
from vacante.digest import D1  # noqa: E402

SINCE = os.environ.get("SINCE", "2026-11-01")
QUERIES = [
    ("подписчики: всего / активные (нажали «Готово» и не /stop)",
     "SELECT COUNT(*) AS total, SUM(active) AS active FROM subscribers"),
    ("по городам", "SELECT coalesce(city, 'весь КЗ') AS city, COUNT(*) AS total, SUM(active) AS active FROM subscribers GROUP BY 1 ORDER BY 2 DESC"),
    ("новые по дням с периода (UTC)",
     "SELECT date(created_at) AS day, COUNT(*) AS n, SUM(active) AS active FROM subscribers WHERE created_at >= ? GROUP BY 1 ORDER BY 1"),
    ("с фильтрами", "SELECT SUM(categories != '') AS with_categories, SUM(perks != '') AS with_perks, SUM(min_pay > 0) AS with_pay FROM subscribers WHERE active = 1"),
    ("модераторы (админы бота) и их подписка",
     "SELECT COUNT(*) AS admins, SUM(s.chat_id IS NOT NULL) AS subscribed, SUM(coalesce(s.active, 0)) AS active, "
     "group_concat(coalesce(s.city, 'весь КЗ') || ' / сферы: ' || coalesce(nullif(s.categories, ''), 'любые') || ' / от ' || coalesce(s.min_pay, 0), '; ') AS filters "
     "FROM admins a LEFT JOIN subscribers s ON s.chat_id = a.chat_id"),
    ("фильтры активных подписок (без chat_id; первая строка, если есть — модератор)",
     "SELECT (s.chat_id IN (SELECT chat_id FROM admins)) AS admin, coalesce(s.city, 'весь КЗ') AS city, s.categories, s.perks, s.min_pay "
     "FROM subscribers s WHERE s.active = 1 ORDER BY admin DESC"),
    ("начатые диалоги сейчас", "SELECT mode, COUNT(*) AS n FROM dialogs GROUP BY mode"),
]

with httpx.Client(timeout=30) as client:
    d1 = D1(client, os.environ["CLOUDFLARE_ACCOUNT_ID"], os.environ["CLOUDFLARE_API_TOKEN"])
    for title, sql in QUERIES:
        try:
            rows = d1.query(sql, [SINCE] if "?" in sql else None)
        except (httpx.HTTPError, RuntimeError) as exc:
            print(f"--- {title}: ошибка {type(exc).__name__}")
            continue
        print(f"--- {title}")
        for row in rows:
            print("   ", row)

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
    ("работодатели: вакансии и смены по дням создания с периода (UTC+5, статус)",
     "SELECT date(created_at, '+5 hours') AS day, kind, status, COUNT(*) AS n, SUM(pro) AS pro, "
     "COUNT(DISTINCT employer_chat) AS employers FROM jobs WHERE created_at >= ? GROUP BY 1, 2, 3 ORDER BY 1, 2, 3"),
    ("работодатели: на каком вопросе бросили черновик (kind, step)",
     "SELECT kind, coalesce(step, '—') AS step, COUNT(*) AS n FROM jobs WHERE status = 'draft' AND created_at >= ? GROUP BY 1, 2 ORDER BY 3 DESC"),
    ("работодатели: откуда пришли (came_from) с периода",
     "SELECT coalesce(nullif(came_from, ''), '—') AS came_from, COUNT(*) AS jobs, COUNT(DISTINCT employer_chat) AS employers "
     "FROM jobs WHERE created_at >= ? GROUP BY 1 ORDER BY 2 DESC"),
    ("работодатели: одобренные по дням одобрения с периода (UTC+5)",
     "SELECT date(approved_at, '+5 hours') AS day, kind, COUNT(*) AS n, SUM(pro) AS pro FROM jobs "
     "WHERE approved_at >= ? GROUP BY 1, 2 ORDER BY 1, 2"),
    ("отклики в боте по дням с периода (UTC+5, вид вакансии)",
     "SELECT date(a.created_at, '+5 hours') AS day, coalesce(j.kind, '?') AS kind, COUNT(*) AS n, "
     "COUNT(DISTINCT a.chat_id) AS people, SUM(a.attended = 1) AS attended, SUM(a.attended = 0) AS no_show "
     "FROM applications a LEFT JOIN jobs j ON j.id = a.job_id WHERE a.created_at >= ? GROUP BY 1, 2 ORDER BY 1, 2"),
    ("оплаты по дням с периода (UTC+5)",
     "SELECT date(created_at, '+5 hours') AS day, kind, status, amount, COUNT(*) AS n FROM payments "
     "WHERE created_at >= ? GROUP BY 1, 2, 3, 4 ORDER BY 1"),
    ("оплаты за всё время по статусу",
     "SELECT status, COUNT(*) AS n, SUM(amount) AS tenge FROM payments GROUP BY 1"),
    ("пакеты Про: куплено / осталось",
     "SELECT COUNT(*) AS packs, SUM(total) AS total, SUM(left) AS left FROM credits"),
    ("входы на сайт через бота с периода (UTC+5): кодов / подтверждено",
     "SELECT date(created_at, '+5 hours') AS day, COUNT(*) AS codes, SUM(chat_id IS NOT NULL) AS confirmed "
     "FROM logins WHERE created_at >= ? GROUP BY 1 ORDER BY 1"),
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

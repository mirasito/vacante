"""Данные для админки /admin/: источники, решения по постам, автопостинг и подписчики бота.

Страница статическая и не попадает в sitemap, а данные и так лежат в открытой ветке data,
поэтому сюда идёт только то, что уже публично: ссылки на посты открытых каналов и их
первые строки без телефонов.
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path

from vacante.journal import ACCEPTED, DUPLICATE, GONE, REJECTED
from vacante.models import Vacancy
from vacante.parse import CATEGORIES, CITIES, REJECT_REASONS

SILENT_DAYS = 3  # канал без новых постов дольше этого считаем замолчавшим
RECENT_POSTED = 15


def _read(path: Path) -> dict | None:
    return json.loads(path.read_text("utf-8")) if path.exists() else None


def _city(slug: str | None) -> str:
    return CITIES[slug][0] if slug in CITIES else "Весь Казахстан"


def admin_data(data_dir: Path, vacancies: list[Vacancy], channels: dict[str, str], now: datetime) -> dict:
    """channels: город → ссылка на свой канал vacante (для блока автопостинга)."""
    journal = _read(data_dir / "journal.json") or {"channels": {}, "posts": []}
    posts = journal["posts"]
    live = {v.id: v for v in vacancies}
    day_ago = (now - timedelta(days=1)).isoformat()
    silent_after = (now - timedelta(days=SILENT_DAYS)).isoformat()

    per_channel: dict[str, Counter] = defaultdict(Counter)
    last_post: dict[str, str] = {}
    for p in posts:
        per_channel[p["channel"]][p["status"]] += 1
        last_post[p["channel"]] = max(last_post.get(p["channel"], ""), p["posted_at"])
    on_site = Counter(v.id.rpartition("-")[0] for v in vacancies)

    sources = []
    for name, info in journal["channels"].items():
        c = per_channel[name]
        sources.append({
            "name": name, "city": _city(info.get("city")) if info.get("city") else "—",
            "checked_at": info["checked_at"], "error": info.get("error"),
            "posts": sum(c.values()), "accepted": c[ACCEPTED], "duplicate": c[DUPLICATE],
            "rejected": c[REJECTED] + c[GONE], "on_site": on_site[name.lower()],
            "last_post_at": last_post.get(name),
        })
    sources.sort(key=lambda s: (-s["accepted"], -s["posts"], s["name"].lower()))

    statuses = Counter(p["status"] for p in posts)
    totals = {
        "on_site": len(vacancies),
        "new_24h": sum(1 for p in posts if p["status"] == ACCEPTED and p["posted_at"] >= day_ago),
        "posts": len(posts),
        "accepted": statuses[ACCEPTED],
        "duplicate": statuses[DUPLICATE],
        "rejected": statuses[REJECTED] + statuses[GONE],
        "channels": len(sources),
        "errors": sum(1 for s in sources if s["error"]),
        "silent": sum(1 for s in sources if not s["error"] and (s["last_post_at"] or "") < silent_after),
    }
    reasons = Counter(p["reason"] or "gone" for p in posts if p["status"] in (REJECTED, GONE))

    posted = _read(data_dir / "posted.json") or {}
    autopost = []
    for city, url in channels.items():
        state = posted.get(city, {"ids": [], "titles": [], "last_at": None})
        recent = list(zip(state["ids"], state["titles"]))[-RECENT_POSTED:][::-1]
        autopost.append({"city": _city(city), "channel": url, "count": len(state["ids"]), "last_at": state["last_at"],
                         "recent": [{"id": i, "title": t, "live": i in live} for i, t in recent]})

    bot = _read(data_dir / "bot.json")
    if bot:
        bot["subscribers"] = sorted(
            ({"city": _city(row.get("city")), "total": int(row["total"] or 0), "active": int(row["active"] or 0)}
             for row in bot["subscribers"]), key=lambda r: -r["active"])

    return {
        "generated_at": now.isoformat(timespec="seconds"),
        "totals": totals,
        "reasons": [{"code": code, "label": REJECT_REASONS.get(code, "Пропала с сайта"), "count": n}
                    for code, n in reasons.most_common()],
        "by_city": Counter(_city(v.city) for v in vacancies).most_common(),
        "by_category": Counter(CATEGORIES[v.category] for v in vacancies).most_common(),
        "sources": sources,
        "posts": posts,
        "autopost": autopost,
        "bot": bot,
    }

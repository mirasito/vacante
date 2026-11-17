"""Охват своих каналов: сколько подписчиков и сколько просмотров набирает пост за сутки.

Показатель этапа «канал Алматы»: доля подписчиков, которые видят пост. Bot API просмотров не отдаёт, поэтому
раз в день читаем открытое веб-превью своего канала t.me/s/<канал> и берём посты, которым от суток до двух:
к этому времени пост набрал почти все свои просмотры. Число подписчиков даёт Bot API (getChatMemberCount).
Замеры хранятся в posted.json (город → "reach") и видны в админке в блоке автопостинга.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from statistics import median

import httpx
from bs4 import BeautifulSoup

from vacante import tg
from vacante.localtime import LOCAL
from vacante.sources.telegram import BASE_URL, USER_AGENT

log = logging.getLogger(__name__)

HOUR = 9  # замер раз в день после этого часа по Казахстану
KEEP = 120  # сколько дней замеров помнить
PAGES = 3  # сколько страниц превью листать назад, по ~20 постов
AGE = (timedelta(hours=24), timedelta(hours=48))  # посты какого возраста считаем
VIEWS = re.compile(r"([\d.]+)\s*([KkMm]?)")

# Канал → {"subscribers": число или None, "views": [(когда вышел пост, просмотры)]}; None — не удалось узнать
Meter = Callable[[str], "dict | None"]


def parse_views(page: str) -> list[tuple[int, datetime, int]]:
    """Посты страницы t.me/s/<канал>: (номер, когда вышел, просмотры). «1.2K» → 1200."""
    out = []
    for node in BeautifulSoup(page, "lxml").select("div.tgme_widget_message[data-post]"):
        views = node.select_one("span.tgme_widget_message_views")
        time_node = node.select_one("a.tgme_widget_message_date time[datetime]")
        m = VIEWS.fullmatch(views.get_text().strip()) if views else None
        if not m or time_node is None:
            continue
        count = float(m.group(1)) * {"": 1, "k": 1_000, "m": 1_000_000}[m.group(2).lower()]
        out.append((int(node["data-post"].rsplit("/", 1)[1]),
                    datetime.fromisoformat(time_node["datetime"]).astimezone(timezone.utc), round(count)))
    return out


def measure(views: list[tuple[datetime, int]], subscribers: int | None, now: datetime) -> dict:
    """Замер дня: медиана просмотров у постов, которым от суток до двух, и доля от подписчиков."""
    counted = [n for at, n in views if AGE[0] <= now - at < AGE[1]]
    seen = round(median(counted)) if counted else None
    share = round(100 * seen / subscribers, 1) if seen is not None and subscribers else None
    return {"subscribers": subscribers, "posts": len(counted), "views": seen, "share": share}


def record(state: dict, chat: str, now: datetime, meter: Meter) -> None:
    """Раз в день дописывает замер в state["reach"]; state — posted.json[город]."""
    local = now.astimezone(LOCAL)
    today = local.date().isoformat()
    tried = f"{today}T{local.hour:02d}"
    if local.hour < HOUR or state.get("reach_on") == today or state.get("reach_try") == tried:
        return
    state["reach_try"] = tried  # не вышло: следующая попытка через час, а не через пять минут
    got = meter(chat)
    if got is None:
        return
    state["reach_on"] = today
    state["reach"] = (state.get("reach", []) + [{"on": today, **measure(got["views"], got["subscribers"], now)}])[-KEEP:]


def telegram_meter(client: httpx.Client, token: str) -> Meter:
    def meter(chat: str) -> dict | None:
        name = chat.lstrip("@")
        try:
            r = client.post(tg.url(token, "getChatMemberCount"), data={"chat_id": chat})
            subscribers = r.json().get("result") if r.status_code == 200 else None
            views: dict[int, tuple[datetime, int]] = {}
            before = None
            for _ in range(PAGES):
                page = client.get(BASE_URL.format(channel=name), params={"before": before} if before else None,
                                  headers={"User-Agent": USER_AGENT}, follow_redirects=True)
                page.raise_for_status()
                posts = parse_views(page.text)
                if not posts:
                    break
                views.update({post_id: (at, n) for post_id, at, n in posts})
                oldest = min(posts)
                if datetime.now(timezone.utc) - oldest[1] >= AGE[1]:
                    break
                before = oldest[0]
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("охват %s: %s", chat, type(exc).__name__)  # в тексте ошибки адрес запроса с токеном
            return None
        return {"subscribers": subscribers if isinstance(subscribers, int) else None, "views": list(views.values())}
    return meter

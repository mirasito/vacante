"""Сбор постов из публичных Telegram-каналов через веб-превью t.me/s/<канал>.

Веб-превью открыто без авторизации и не требует Telegram-аккаунта или API-ключей.
Одна страница отдаёт ~20 последних постов, старые листаются параметром ?before=<id>.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone

import httpx
from bs4 import BeautifulSoup

from vacante.models import RawPost

log = logging.getLogger(__name__)

BASE_URL = "https://t.me/s/{channel}"
USER_AGENT = "Mozilla/5.0 (compatible; vacante.kz-bot/0.1; +https://vacante.kz)"


def parse_channel_page(html: str, channel: str, default_city: str | None = None) -> list[RawPost]:
    """Достаёт посты из HTML страницы t.me/s/<канал>. Посты без текста пропускаются."""
    soup = BeautifulSoup(html, "lxml")
    posts = []
    for node in soup.select("div.tgme_widget_message[data-post]"):
        text_node = node.select_one("div.tgme_widget_message_text")
        time_node = node.select_one("a.tgme_widget_message_date time[datetime]")
        if text_node is None or time_node is None:
            continue
        for br in text_node.find_all("br"):
            br.replace_with("\n")
        text = text_node.get_text().strip()
        if not text:
            continue
        data_post = node["data-post"]  # "<channel>/<id>"
        post_id = int(data_post.rsplit("/", 1)[1])
        posts.append(
            RawPost(
                source="telegram",
                channel=channel,
                post_id=post_id,
                url=f"https://t.me/{data_post}",
                text=text,
                posted_at=datetime.fromisoformat(time_node["datetime"]).astimezone(timezone.utc),
                default_city=default_city,
            )
        )
    return posts


def fetch_channel(
    client: httpx.Client,
    channel: str,
    default_city: str | None = None,
    since_id: int = 0,
    max_age_days: int = 14,
    max_pages: int = 3,
    delay: float = 1.5,
) -> list[RawPost]:
    """Скачивает посты канала новее since_id и не старше max_age_days."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
    collected: list[RawPost] = []
    before: int | None = None
    for _ in range(max_pages):
        params = {"before": before} if before else None
        resp = client.get(BASE_URL.format(channel=channel), params=params)
        resp.raise_for_status()
        page = parse_channel_page(resp.text, channel, default_city)
        if not page:
            break
        fresh = [p for p in page if p.post_id > since_id and p.posted_at >= cutoff]
        collected.extend(fresh)
        oldest = min(page, key=lambda p: p.post_id)
        if oldest.post_id <= since_id or oldest.posted_at < cutoff:
            break
        before = oldest.post_id
        time.sleep(delay)
    return collected


def make_client() -> httpx.Client:
    return httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=20, follow_redirects=True)

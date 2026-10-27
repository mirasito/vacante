"""Журнал сбора для админки: что пришло из каждого канала и что с этим стало.

Каждый пост за последние две недели: принят (стал карточкой), дубль (склеен с карточкой
из другого поста) или отброшен с причиной. По каналам: когда проверяли и была ли ошибка.
Хранится в journal.json рядом с вакансиями. Текст постов не храним, только первую строку
без телефонов и ссылок: сам пост открывается по ссылке.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from vacante.models import RawPost, Vacancy
from vacante.parse import clean_text

ACCEPTED, DUPLICATE, REJECTED, GONE = "accepted", "duplicate", "rejected", "gone"
SNIPPET = 140
MAX_POSTS = 20_000


def snippet(text: str) -> str:
    lines = [line.strip() for line in clean_text(text).splitlines() if line.strip()]
    short = " · ".join(lines[:2])
    return short if len(short) <= SNIPPET else short[: SNIPPET - 1].rstrip() + "…"


class Journal:
    def __init__(self, posts: dict[str, dict] | None = None, channels: dict[str, dict] | None = None):
        self.posts = posts or {}
        self.channels = channels or {}

    @classmethod
    def load(cls, data_dir: Path) -> Journal | None:
        """None, если журнала ещё нет: тогда сбор перечитывает каналы за все две недели."""
        path = data_dir / "journal.json"
        if not path.exists():
            return None
        data = json.loads(path.read_text("utf-8"))
        return cls({p["id"]: p for p in data["posts"]}, data["channels"])

    def save(self, data_dir: Path) -> None:
        posts = sorted(self.posts.values(), key=lambda p: p["posted_at"], reverse=True)[:MAX_POSTS]
        payload = {"channels": self.channels, "posts": posts}
        (data_dir / "journal.json").write_text(json.dumps(payload, ensure_ascii=False, indent=0) + "\n", "utf-8")

    def checked(self, channel: str, city: str | None, now: datetime, posts: int = 0, error: str | None = None) -> None:
        self.channels[channel] = {"city": city, "checked_at": now.isoformat(timespec="seconds"),
                                  "new_posts": posts, "error": error}

    def add(self, post: RawPost, vacancy: Vacancy | None, reason: str | None) -> None:
        post_id = f"{post.channel.lower()}-{post.post_id}"
        self.posts[post_id] = {
            "id": post_id,
            "channel": post.channel,
            "url": post.url,
            "posted_at": post.posted_at.isoformat(timespec="seconds"),
            "status": ACCEPTED if vacancy else REJECTED,
            "reason": reason,
            "title": vacancy.title if vacancy else None,
            "snippet": snippet(post.text),
            "vacancy": None,
        }

    def settle(self, vacancies: list[Vacancy], dropped: dict[str, str], max_age_days: int,
               now: datetime | None = None) -> None:
        """Сверяет журнал с итоговым списком вакансий после склейки дублей и чистки старых."""
        now = now or datetime.now(timezone.utc)
        kept = {v.id for v in vacancies}
        twin_of = {url: v.id for v in vacancies for url in v.also_seen_in}
        for p in self.posts.values():
            if p["status"] == REJECTED:
                continue
            if p["id"] in kept:
                p["status"], p["vacancy"] = ACCEPTED, p["id"]
            elif p["url"] in twin_of:
                p["status"], p["vacancy"] = DUPLICATE, twin_of[p["url"]]
            elif p["id"] in dropped:
                p["status"], p["reason"], p["vacancy"] = REJECTED, dropped[p["id"]], None
            else:
                p["status"], p["vacancy"] = GONE, None
        cutoff = (now - timedelta(days=max_age_days)).isoformat()
        self.posts = {k: p for k, p in self.posts.items() if p["posted_at"] >= cutoff}

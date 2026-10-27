"""Один проход сбора: каналы → разбор → склейка дублей → сохранение."""

from __future__ import annotations

import logging
from pathlib import Path

import httpx
import yaml

from vacante.parse import parse_post
from vacante.sources import telegram
from vacante.store import expire, load_state, load_vacancies, merge, save_state, save_vacancies

log = logging.getLogger(__name__)


def load_channels(config_path: Path) -> list[dict]:
    config = yaml.safe_load(config_path.read_text("utf-8"))
    return [c for c in config["channels"] if c.get("enabled", True)]


def run(config_path: Path, data_dir: Path, max_age_days: int = 14) -> dict:
    channels = load_channels(config_path)
    state = load_state(data_dir)
    last_ids: dict[str, int] = state.setdefault("last_post_id", {})
    stats = {"channels": len(channels), "failed": 0, "posts": 0, "vacancies": 0}
    incoming = []
    with telegram.make_client() as client:
        for ch in channels:
            name = ch["username"]
            try:
                posts = telegram.fetch_channel(
                    client, name, ch.get("city"), since_id=last_ids.get(name, 0), max_age_days=max_age_days
                )
            except httpx.HTTPError as exc:
                log.warning("канал %s: %s", name, exc)
                stats["failed"] += 1
                continue
            stats["posts"] += len(posts)
            for post in posts:
                vacancy = parse_post(post)
                if vacancy:
                    incoming.append(vacancy)
            if posts:
                last_ids[name] = max(last_ids.get(name, 0), *(p.post_id for p in posts))
    stats["vacancies"] = len(incoming)
    incoming.sort(key=lambda v: v.posted_at)
    vacancies = expire(merge(load_vacancies(data_dir), incoming), max_age_days)
    save_vacancies(data_dir, vacancies)
    save_state(data_dir, state)
    stats["total"] = len(vacancies)
    return stats

"""Один проход сбора: каналы → разбор → склейка дублей → сохранение."""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path

import httpx
import yaml

from vacante.models import RawPost, Vacancy
from vacante.parse import parse_post
from vacante.sources import telegram
from vacante.store import expire, load_state, load_vacancies, merge, save_state, save_vacancies

log = logging.getLogger(__name__)


def load_channels(config_path: Path) -> list[dict]:
    config = yaml.safe_load(config_path.read_text("utf-8"))
    return [c for c in config["channels"] if c.get("enabled", True)]


def reparse(vacancies: list[Vacancy], cities: dict[str, str | None]) -> list[Vacancy]:
    """Заново разбирает сохранённые карточки, чтобы улучшения разбора доходили и до уже собранных вакансий.

    Разбирается сохранённый (очищенный) текст. id, дата и склейки с повторами остаются прежними,
    а карточки, которые новый разбор не считает вакансиями, уходят.
    """
    result = []
    for old in vacancies:
        channel, _, post_id = old.id.rpartition("-")
        raw = RawPost(old.source, channel, int(post_id), old.source_url, old.text,
                      datetime.fromisoformat(old.posted_at), cities.get(channel, old.city))
        new = parse_post(raw)
        if new is None:
            continue
        new.posted_at, new.fingerprint, new.also_seen_in = old.posted_at, old.fingerprint, old.also_seen_in
        result.append(new)
    return result


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
    cities = {ch["username"].lower(): ch.get("city") for ch in channels}
    existing = reparse(load_vacancies(data_dir), cities)
    vacancies = expire(merge(existing, incoming), max_age_days)
    save_vacancies(data_dir, vacancies)
    save_state(data_dir, state)
    stats["total"] = len(vacancies)
    return stats

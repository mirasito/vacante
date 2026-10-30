"""Один проход сбора: каналы → разбор → склейка дублей → сохранение."""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from pathlib import Path

import httpx
import yaml

from vacante import direct as direct_jobs
from vacante import parse, quality
from vacante.journal import Journal
from vacante.models import RawPost, Vacancy
from vacante.parse import explain, split_title
from vacante.sources import hh, telegram
from vacante.store import expire, load_state, load_vacancies, merge, save_state, save_vacancies

log = logging.getLogger(__name__)


def parser_version() -> str:
    """Меняется при любой правке правил разбора."""
    return hashlib.sha1(Path(parse.__file__).read_bytes()).hexdigest()[:12]


def load_channels(config_path: Path) -> list[dict]:
    config = yaml.safe_load(config_path.read_text("utf-8"))
    return [c for c in config["channels"] if c.get("enabled", True)]


def reparse(vacancies: list[Vacancy], cities: dict[str, str | None],
            dropped: dict[str, str] | None = None) -> list[Vacancy]:
    """Заново разбирает сохранённые карточки, чтобы улучшения разбора доходили и до уже собранных вакансий.

    Разбирается сохранённый (очищенный) текст. id, дата и склейки с повторами остаются прежними,
    а карточки, которые новый разбор не считает вакансиями, уходят (их причины пишутся в dropped).
    """
    result = []
    for old in vacancies:
        channel, _, post_id = old.id.rpartition("-")
        raw = RawPost(old.source, channel, int(post_id), old.source_url, old.text,
                      datetime.fromisoformat(old.posted_at), cities.get(channel, old.city))
        new, reason = explain(raw)
        if new is None:
            if dropped is not None:
                dropped[old.id] = reason
            continue
        new.posted_at, new.fingerprint, new.also_seen_in = old.posted_at, old.fingerprint, old.also_seen_in
        result.append(new)
    return result


def run(config_path: Path, data_dir: Path, max_age_days: int = 14, fetch=telegram.fetch_channel,
        now: datetime | None = None, direct: list[Vacancy] | None = None, from_hh=hh.collect) -> dict:
    """direct: одобренные вакансии от работодателей из бота (vacante.direct). None значит, что базу бота
    прочитать не удалось или её нет: тогда такие вакансии на сайте остаются как были.
    from_hh: новые вакансии hh.kz (vacante.sources.hh), None — источник выключен или недоступен."""
    now = now or datetime.now(timezone.utc)
    channels = load_channels(config_path)
    state = load_state(data_dir)
    last_ids: dict[str, int] = state.setdefault("last_post_id", {})
    journal = Journal.load(data_dir)
    # Журнала ещё нет или правила разбора поменялись: перечитываем каналы за все две недели,
    # чтобы в журнале была полная картина, а посты, отброшенные старыми правилами, получили
    # второй шанс. Уже собранные посты при этом не задваиваются: склейка узнаёт их по id.
    version = parser_version()
    # Текстов отброшенных постов ещё нет (rejected.json): тоже перечитываем, чтобы агенту-технологу было что смотреть.
    rejected = quality.load_rejected(data_dir)
    rescan = journal is None or rejected is None or state.get("parser") != version
    rejected = rejected or {}
    state["parser"] = version
    journal = journal or Journal()
    stats = {"channels": len(channels), "failed": 0, "posts": 0, "vacancies": 0}
    incoming = []
    with telegram.make_client() as client:
        for ch in channels:
            name = ch["username"]
            try:
                posts = fetch(client, name, ch.get("city"), since_id=0 if rescan else last_ids.get(name, 0),
                              max_age_days=max_age_days)
            except httpx.HTTPError as exc:
                log.warning("канал %s: %s", name, exc)
                stats["failed"] += 1
                journal.checked(name, ch.get("city"), now, error=type(exc).__name__)
                continue
            journal.checked(name, ch.get("city"), now, posts=len(posts))
            stats["posts"] += len(posts)
            for post in posts:
                vacancy, reason = explain(post)
                journal.add(post, vacancy, reason)
                if vacancy:
                    incoming.append(vacancy)
                else:
                    item = quality.rejected_item(post, reason)
                    rejected[item["id"]] = item
            if posts:
                last_ids[name] = max(last_ids.get(name, 0), *(p.post_id for p in posts))
    journal.channels = {c["username"]: journal.channels[c["username"]] for c in channels}  # убранные из конфига уходят
    stats["vacancies"] = len(incoming)
    if (hh_vacancies := from_hh(state, now)) is not None:
        stats["hh"] = len(hh_vacancies)
        incoming += hh_vacancies
    incoming.sort(key=lambda v: v.posted_at)
    cities = {ch["username"].lower(): ch.get("city") for ch in channels}
    dropped: dict[str, str] = {}
    saved = load_vacancies(data_dir)
    from_bot = [v for v in saved if v.source == direct_jobs.SOURCE]
    if direct is not None:
        # Закрытые работодателем уходят, новые одобренные приходят. Склейки с повторами
        # из каналов сохраняем: такие повторы сами больше не приходят.
        previous = {v.id: v for v in from_bot}
        for v in direct:
            if v.id in previous:
                v.also_seen_in = previous[v.id].also_seen_in
                v.posted_at = max(v.posted_at, previous[v.id].posted_at)
        from_bot = direct
        stats["direct"] = len(direct)
    # Правилами заново разбираем только посты из каналов: у вакансий hh поля уже разложены по полочкам
    existing = reparse([v for v in saved if v.source == "telegram"], cities, dropped)
    from_hh_saved = [v for v in saved if v.source == hh.SOURCE]
    for v in from_hh_saved:
        if v.title_kk is None:  # сохранённые до разделения двуязычных названий
            v.title, v.title_kk = split_title(v.title)
    # Вакансии от работодателей первыми: повтор той же вакансии из канала склеится с ними, а не наоборот
    vacancies = expire(merge(from_bot + existing + from_hh_saved, incoming), max_age_days, now)
    journal.settle(vacancies, dropped, max_age_days, now)
    for v in saved:
        if v.id in dropped:
            rejected[v.id] = quality.dropped_item(v, dropped[v.id])
    save_vacancies(data_dir, vacancies)
    save_state(data_dir, state)
    journal.save(data_dir)
    quality.save_rejected(data_dir, rejected, journal.posts)
    stats["total"] = len(vacancies)
    return stats

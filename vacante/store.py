"""Хранилище вакансий: JSON-файлы в папке данных (в CI это ветка data)."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from vacante.models import Vacancy
from vacante.parse import word_set

NEAR_DUPLICATE = 0.85  # доля общих слов, начиная с которой два поста считаем одной вакансией


def load_vacancies(data_dir: Path) -> list[Vacancy]:
    path = data_dir / "vacancies.json"
    if not path.exists():
        return []
    return [Vacancy.from_dict(v) for v in json.loads(path.read_text("utf-8"))]


def save_vacancies(data_dir: Path, vacancies: list[Vacancy]) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    vacancies = sorted(vacancies, key=lambda v: v.posted_at, reverse=True)
    payload = json.dumps([v.to_dict() for v in vacancies], ensure_ascii=False, indent=1)
    (data_dir / "vacancies.json").write_text(payload + "\n", "utf-8")


def load_state(data_dir: Path) -> dict:
    path = data_dir / "state.json"
    return json.loads(path.read_text("utf-8")) if path.exists() else {"last_post_id": {}}


def save_state(data_dir: Path, state: dict) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "state.json").write_text(json.dumps(state, ensure_ascii=False, indent=1) + "\n", "utf-8")


def _jaccard(a: set[str], b: set[str]) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def merge(existing: list[Vacancy], incoming: list[Vacancy]) -> list[Vacancy]:
    """Добавляет новые вакансии, склеивая повторы одной и той же вакансии из разных каналов.

    У повтора остаётся первая карточка: её ссылка-источник, а ссылки повторов уходят в
    also_seen_in. Дата берётся самая свежая: повторная публикация значит, что место ещё открыто.
    """
    result = list(existing)
    by_id = {v.id: v for v in result}
    by_fp = {v.fingerprint: v for v in result}
    words = {v.id: word_set(v.text) for v in result}
    for new in incoming:
        if new.id in by_id:
            continue
        twin = by_fp.get(new.fingerprint)
        if twin is None:
            new_words = word_set(new.text)
            for old in result:
                if old.city == new.city and old.title == new.title and _jaccard(words[old.id], new_words) >= NEAR_DUPLICATE:
                    twin = old
                    break
        if twin is not None:
            if new.source_url != twin.source_url and new.source_url not in twin.also_seen_in:
                twin.also_seen_in.append(new.source_url)
            twin.posted_at = max(twin.posted_at, new.posted_at)
            by_id[new.id] = twin
            continue
        result.append(new)
        by_id[new.id] = new
        by_fp[new.fingerprint] = new
        words[new.id] = word_set(new.text)
    return result


def expire(vacancies: list[Vacancy], max_age_days: int, now: datetime | None = None) -> list[Vacancy]:
    now = now or datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=max_age_days)).isoformat()
    # Оплаченное «🔥 Срочно» держит вакансию на сайте, даже если она старше срока
    return [v for v in vacancies if v.posted_at >= cutoff or v.is_top(now)]

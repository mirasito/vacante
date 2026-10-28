"""Проверка агентом вакансий из чужих каналов перед постом в свои каналы.

Сбор каждый час выкладывает в post_queue.json ветки data ближайшие кандидаты на пост в каждом городе
(их выбирает autopost.write_review_queue). Агент-модератор (.claude/skills/moderate-vacancies) одобряет
или отклоняет их и поправляет поля карточки, а workflow review-posts.yml записывает решения сюда,
в post_reviews.json. Пока этого файла нет, автопостинг работает по-старому, без проверки; когда он есть,
в каналы идут только одобренные агентом вакансии из каналов. На сайт решения не влияют.
"""

from __future__ import annotations

import dataclasses
import json
from datetime import datetime, timezone
from pathlib import Path

from vacante.models import Vacancy
from vacante.parse import PERKS

QUEUE = "post_queue.json"
REVIEWS = "post_reviews.json"
VERDICTS = {"approve", "reject"}
TEXT_FIELDS = {"title": 80, "employer": 80, "schedule": 80, "address": 120}
# Допустимые суммы, как у вакансий от работодателей (moderate-vacancies)
PERIODS = {"hour": (300, 15_000), "day": (2_000, 150_000), "month": (40_000, 5_000_000)}
PERK_NAMES = [name for name, _ in PERKS] + ["Можно студентам"]
REASON_LIMIT = 200


def load(data_dir: Path) -> dict | None:
    """Решения агента {id вакансии: {verdict, fields, reason, at}} или None, если проверки ещё не было."""
    try:
        return json.loads((data_dir / REVIEWS).read_text("utf-8"))["reviews"]
    except (OSError, ValueError, KeyError):
        return None


def reviewed(v: Vacancy, review: dict | None) -> Vacancy:
    """Вакансия с полями, которые поправил агент."""
    fields = (review or {}).get("fields") or {}
    return dataclasses.replace(v, **fields) if fields else v


def queue_item(v: Vacancy) -> dict:
    """Кандидат на пост в очереди для агента: только то, что и так есть на сайте."""
    item = {k: getattr(v, k) for k in ("id", "city", "title", "employer", "salary_min", "salary_max", "salary_period",
                                       "schedule", "address", "perks", "category", "posted_at", "source_url")}
    item["text"] = v.text
    return item


def _check_fields(fields: dict) -> str | None:
    """Текст ошибки или None, если поля можно записать."""
    allowed = set(TEXT_FIELDS) | {"perks", "salary_min", "salary_max", "salary_period"}
    if unknown := sorted(set(fields) - allowed):
        return f"лишние поля {', '.join(unknown)}"
    for key, limit in TEXT_FIELDS.items():
        if key in fields:
            value = fields[key]
            if value is not None and not isinstance(value, str):
                return f"{key}: нужна строка"
            if key == "title" and not (value or "").strip():
                return "title: пустая должность"
            if value and len(value) > limit:
                return f"{key}: длиннее {limit} символов"
    if "perks" in fields:
        perks = fields["perks"]
        if not isinstance(perks, list) or any(p not in PERK_NAMES for p in perks):
            return f"perks: список из {', '.join(PERK_NAMES)}"
    salary = {k: fields[k] for k in ("salary_min", "salary_max", "salary_period") if k in fields}
    if salary:
        period, low, high = salary.get("salary_period"), salary.get("salary_min"), salary.get("salary_max")
        if period is None and low is None and high is None:
            return None  # зарплату убрали
        if period not in PERIODS:
            return "salary_period: month, day или hour"
        lo, hi = PERIODS[period]
        for name, value in (("salary_min", low), ("salary_max", high)):
            if value is not None and (not isinstance(value, int) or isinstance(value, bool) or not lo <= value <= hi):
                return f"{name}: целое число от {lo} до {hi}"
        if low is None and high is None:
            return "нужна salary_min или salary_max"
        if low is not None and high is not None and low > high:
            return "salary_min больше salary_max"
    return None


def _normalize(fields: dict) -> dict:
    out = {}
    for key, value in fields.items():
        if key in TEXT_FIELDS:
            value = (value or "").strip() or None
            if key == "title":
                value = value[:1].upper() + value[1:]
        out[key] = value
    if any(k in out for k in ("salary_min", "salary_max", "salary_period")):
        # Зарплату передают целиком: чего нет, того нет
        for k in ("salary_min", "salary_max", "salary_period"):
            out.setdefault(k, None)
        if out["salary_period"] is None:
            out["salary_min"] = out["salary_max"] = None
    return out


def apply(data_dir: Path, decisions: list[dict], vacancies: list[Vacancy],
          now: datetime | None = None) -> list[tuple[str, str]]:
    """Записывает решения агента в post_reviews.json. Возвращает [(id, итог)] для аннотаций."""
    now = now or datetime.now(timezone.utc)
    known = {v.id for v in vacancies}
    reviews = {k: r for k, r in (load(data_dir) or {}).items() if k in known}  # снятые вакансии забываем
    report = []
    for d in decisions:
        vid, verdict = d.get("id"), d.get("verdict")
        if not isinstance(vid, str) or not vid:
            report.append((str(vid), "error: нет id вакансии"))
            continue
        if vid not in known:
            report.append((vid, "skipped: вакансии уже нет на сайте"))
            continue
        if verdict not in VERDICTS:
            report.append((vid, "error: verdict должен быть approve или reject"))
            continue
        entry = {"verdict": verdict, "at": now.isoformat(timespec="seconds")}
        if verdict == "approve":
            fields = d.get("fields") or {}
            if not isinstance(fields, dict):
                report.append((vid, "error: fields должен быть объектом"))
                continue
            if error := _check_fields(fields):
                report.append((vid, f"error: {error}"))
                continue
            entry["fields"] = _normalize(fields)
        else:
            reason = d.get("reason")
            if not isinstance(reason, str) or not reason.strip() or len(reason) > REASON_LIMIT:
                report.append((vid, f"error: нужна причина до {REASON_LIMIT} символов"))
                continue
            entry["reason"] = reason.strip()
        reviews[vid] = entry
        report.append((vid, "approved" if verdict == "approve" else "rejected"))
    payload = {"updated_at": now.isoformat(timespec="seconds"), "reviews": reviews}
    (data_dir / REVIEWS).write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", "utf-8")
    return report

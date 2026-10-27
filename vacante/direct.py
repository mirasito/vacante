"""Вакансии, которые работодатели разместили сами через бота @vacantekz_bot.

Бот хранит их в Cloudflare D1 (таблица jobs, код в bot/). При каждом сборе берём одобренные
модератором и превращаем в обычные карточки: зарплату, сферу и условия разбираем теми же
правилами, что и посты из каналов. Откликаются кандидаты через бота, туда и ведёт ссылка.
"""

from __future__ import annotations

from datetime import datetime, timezone

from vacante.models import Vacancy
from vacante.parse import clean_text, detect_titles, fingerprint, parse_perks, parse_salary

BOT_USERNAME = "vacantekz_bot"
SOURCE = "bot"
POST_URL = f"https://t.me/{BOT_USERNAME}?start=post"


def apply_url(job_id: int) -> str:
    return f"https://t.me/{BOT_USERNAME}?start=apply_{job_id}"


def _iso(sqlite_time: str) -> str:
    """«2026-10-27 12:30:00» из SQLite (это UTC) → ISO 8601, как у постов из каналов."""
    return datetime.fromisoformat(sqlite_time).replace(tzinfo=timezone.utc).isoformat()


def to_vacancy(job: dict) -> Vacancy:
    title = job["title"].strip()
    title = title[:1].upper() + title[1:]
    schedule = job.get("schedule") or None
    details = clean_text(job.get("details") or "")  # контакты не публикуем: отклики идут через бота
    salary_min, salary_max, period = parse_salary(f"Зарплата: {job['salary']}")
    lines = [details or f"{title}, {job['company']}."]
    if salary_min is None and salary_max is None:
        lines.append(f"Зарплата: {job['salary']}")  # «договорная» и подобное покажем как есть
    text = "\n\n".join(lines)
    titles = detect_titles(title) or detect_titles(details)
    return Vacancy(
        id=f"{SOURCE}-{job['id']}",
        title=title,
        category=titles[0][1] if titles else "other",
        city=job["city"],
        salary_min=salary_min,
        salary_max=salary_max,
        salary_period=period,
        schedule=schedule,
        perks=parse_perks(f"{title}\n{schedule or ''}\n{details}"),
        employer=job["company"].strip(),
        text=text,
        source=SOURCE,
        source_url=apply_url(job["id"]),
        posted_at=_iso(job["approved_at"]),
        fingerprint=fingerprint(text),
        address=job.get("address") or None,
    )

"""Смены и подработка: какие вакансии показывать в разделе «Смены».

Отдельных объявлений «смена на завтра» в источниках почти нет, зато много вакансий,
где платят за смену или за час, ежедневно или это прямо подработка. Их и собираем в раздел:
страницы /смены/ на сайте, кнопка «Смены» в приложении и условие подписки в боте.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from vacante.models import Vacancy

# Условие фильтра на сайте и в подписке бота (options.json): то же слово, что и у остальных условий
SHIFT = "Смены и подработка"
# Путь страниц раздела: /smeny/, /almaty/smeny/. Не совпадает ни с одной сферой (vacante.parse.CATEGORIES)
SLUG = "smeny"

# Вид смены → подпись на карточке. Порядок важен: первая подходящая
KINDS = {
    "slot": "Смена на день",
    "part": "Подработка",
    "day": "Оплата за смену",
    "hour": "Почасовая оплата",
    "daily": "Ежедневная оплата",
}


def kind(v: Vacancy) -> str | None:
    """Почему вакансия в разделе «Смены»: slot (смена на конкретный день от работодателя), part, day, hour,
    daily или None, если это обычная работа."""
    if v.shift_date:
        return "slot"
    if v.schedule and "подработка" in v.schedule:
        return "part"
    if v.salary_period in ("day", "hour") and (v.salary_min or v.salary_max):
        return v.salary_period
    if "Ежедневная оплата" in v.perks:
        return "daily"
    return None


WEEKDAYS = {"ru": ["пн", "вт", "ср", "чт", "пт", "сб", "вс"], "kk": ["дс", "сс", "ср", "бс", "жм", "сн", "жс"]}


def day_label(day: str, lang: str = "ru") -> str:
    """«2026-11-07» → «сб, 07.11»."""
    d = date.fromisoformat(day)
    return f"{WEEKDAYS[lang][d.weekday()]}, {d:%d.%m}"


def is_shift(v: Vacancy) -> bool:
    return kind(v) is not None


def ordered(items: list[Vacancy]) -> list[Vacancy]:
    """Список раздела: смены на конкретный день первыми, ближайшие раньше, дальше как было («🔥 Срочно», новизна)."""
    return sorted(items, key=lambda v: (v.shift_date is None, v.shift_date or ""))


def perks(v: Vacancy) -> list[str]:
    """Условия вакансии вместе с «Смены и подработка»: по ним фильтр сайта и подписки бота."""
    return [*v.perks, SHIFT] if is_shift(v) else v.perks


LOCAL = timezone(timedelta(hours=5))  # время Казахстана


def upcoming(vacancies: list[Vacancy], now: datetime, hours: int = 36, days: int = 1) -> list[Vacancy]:
    """Что предложить сейчас: смены на день от работодателей на сегодня и ближайшие days дней,
    потом свежие (за hours часов) вакансии с оплатой за смену, почасовой и подработкой."""
    today = now.astimezone(LOCAL).date()
    last = (today + timedelta(days=days)).isoformat()
    cutoff = (now - timedelta(hours=hours)).isoformat()
    slots = [v for v in vacancies if v.shift_date and today.isoformat() <= v.shift_date <= last]
    rest = [v for v in vacancies if not v.shift_date and is_shift(v) and v.posted_at >= cutoff]
    return ordered(slots) + sorted(rest, key=lambda v: v.posted_at, reverse=True)

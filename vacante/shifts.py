"""Смены и подработка: какие вакансии показывать в разделе «Смены».

Отдельных объявлений «смена на завтра» в источниках почти нет, зато много вакансий,
где платят за смену или за час, ежедневно или это прямо подработка. Их и собираем в раздел:
страницы /смены/ на сайте, кнопка «Смены» в приложении и условие подписки в боте.
"""

from __future__ import annotations

from vacante.models import Vacancy

# Условие фильтра на сайте и в подписке бота (options.json): то же слово, что и у остальных условий
SHIFT = "Смены и подработка"
# Путь страниц раздела: /smeny/, /almaty/smeny/. Не совпадает ни с одной сферой (vacante.parse.CATEGORIES)
SLUG = "smeny"

# Вид смены → подпись на карточке. Порядок важен: первая подходящая
KINDS = {
    "part": "Подработка",
    "day": "Оплата за смену",
    "hour": "Почасовая оплата",
    "daily": "Ежедневная оплата",
}


def kind(v: Vacancy) -> str | None:
    """Почему вакансия в разделе «Смены»: part, day, hour, daily или None, если это обычная работа."""
    if v.schedule and "подработка" in v.schedule:
        return "part"
    if v.salary_period in ("day", "hour") and (v.salary_min or v.salary_max):
        return v.salary_period
    if "Ежедневная оплата" in v.perks:
        return "daily"
    return None


def is_shift(v: Vacancy) -> bool:
    return kind(v) is not None


def perks(v: Vacancy) -> list[str]:
    """Условия вакансии вместе с «Смены и подработка»: по ним фильтр сайта и подписки бота."""
    return [*v.perks, SHIFT] if is_shift(v) else v.perks

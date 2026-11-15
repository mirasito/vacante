"""Ссылка запуска мини-приложения: t.me/vacantekz_bot?startapp=<параметр>.

Telegram передаёт приложению одно значение до 64 символов из латиницы, цифр, «_» и «-», поэтому
источник перехода, город и вакансия собраны в одну строку. Разбирает её приложение (app/src/launch.ts),
и обе стороны должны понимать один формат:

    [s<метка>_] v_<город>_<id вакансии>   вакансия открыта сразу
    [s<метка>_] c_<город>                 лента города

Метка источника — до 8 строчных букв и цифр («tg» — свои каналы). В городе нет «_», поэтому «_» после
него однозначен, а id вакансии идёт до конца строки и может содержать и «_», и «-».
"""

from __future__ import annotations

import re

from vacante import direct

MAX = 64  # предел Telegram для startapp
OWN_CHANNELS = "tg"  # метка источника для постов в своих каналах
SOURCE = re.compile(r"[a-z0-9]{1,8}")
CITY = re.compile(r"[a-z-]{2,30}")
VACANCY = re.compile(r"[A-Za-z0-9_-]+")


def start_param(*, source: str | None = None, city: str | None = None, vacancy_id: str | None = None) -> str | None:
    """Параметр для ссылки или None, если он не поместится в ссылку или в нём недопустимый символ."""
    if not city or not CITY.fullmatch(city):
        return None
    if source is not None and not SOURCE.fullmatch(source):
        return None
    if vacancy_id is not None and not VACANCY.fullmatch(vacancy_id):
        return None
    body = f"v_{city}_{vacancy_id}" if vacancy_id is not None else f"c_{city}"
    param = f"s{source}_{body}" if source else body
    return param if len(param) <= MAX else None


def app_link(param: str) -> str:
    return f"https://t.me/{direct.BOT_USERNAME}?startapp={param}"

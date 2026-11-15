"""Ссылка запуска мини-приложения: t.me/vacantekz_bot?startapp=<параметр>.

Telegram передаёт приложению одно значение до 64 символов из латиницы, цифр, «_» и «-», поэтому
источник перехода, город и вакансия собраны в одну строку. Разбирает её приложение (app/src/launch.ts),
и обе стороны должны понимать один формат:

    [s<метка>_] v_<город>_<id вакансии>   карточка вакансии (заголовки в подборке, старые ссылки)
    [s<метка>_] a_<город>_<id вакансии>   сразу окно отклика на вакансию (кнопки «Откликнуться», «С профилем»)
    [s<метка>_] c_<город>                 лента города

Метка источника — до 8 строчных букв и цифр («tg» — свои каналы). В городе нет «_», поэтому «_» после
него однозначен, а id вакансии идёт до конца строки и может содержать и «_», и «-».
"""

from __future__ import annotations

import os
import re
from urllib.parse import urlencode

from vacante import direct
from vacante.models import Vacancy

MAX = 64  # предел Telegram для startapp
OWN_CHANNELS = "tg"  # метка источника для постов в своих каналах
SOURCE = re.compile(r"[a-z0-9]{1,8}")
CITY = re.compile(r"[a-z-]{2,30}")
VACANCY = re.compile(r"[A-Za-z0-9_-]+")


def start_param(*, source: str | None = None, city: str | None = None, vacancy_id: str | None = None,
                apply: bool = False) -> str | None:
    """Параметр для ссылки или None, если он не поместится в ссылку или в нём недопустимый символ.

    apply — ссылка стоит под словом «Откликнуться»: приложение открывает сразу окно отклика, а не карточку.
    """
    if not city or not CITY.fullmatch(city):
        return None
    if source is not None and not SOURCE.fullmatch(source):
        return None
    if vacancy_id is not None and not VACANCY.fullmatch(vacancy_id):
        return None
    body = f"{'a' if apply else 'v'}_{city}_{vacancy_id}" if vacancy_id is not None else f"c_{city}"
    param = f"s{source}_{body}" if source else body
    return param if len(param) <= MAX else None


def app_link(param: str) -> str:
    return f"https://t.me/{direct.BOT_USERNAME}?startapp={param}"


# Сервер в Казахстане: там контакты работодателей из постов и переход /go/<вакансия>/<вид> (server/src/go.ts)
GO_URL = (os.environ.get("SERVER_URL") or "https://api.vacante.kz").rstrip("/")
# id вакансии из канала: <канал>-<номер поста>. Только для них сервер умеет найти исходный пост
CHANNEL_ID = re.compile(r"[A-Za-z]\w{3,31}-\d{1,10}", re.ASCII)
# Вид контакта в исходном посте → вид перехода на сервере
GO_KINDS = {"whatsapp": "wa", "phone": "call", "telegram": "tg"}


def reply_buttons(v: Vacancy, source: str) -> list[tuple[str, str]]:
    """Кнопки отклика на вакансию из чужого источника: [(вид, ссылка)].

    У вакансии из канала с контактами в посте — прямые кнопки «whatsapp», «phone», «telegram»: ссылка ведёт
    на сервер, а он сразу отправляет человека в чат WhatsApp с готовым текстом, на звонок или в Telegram.
    Сами номера хранятся только на сервере, в открытые данные сайта они не попадают. У остальных
    (hh.kz, OLX, пост без контактов) одна кнопка «apply»: окно отклика на вакансию в мини-приложении.
    source — откуда кнопка, для счётчика нажатий: «web» — сайт, «tg» — свои каналы, «bot» — подборки бота.
    Пусто, если отклик идёт иначе: вакансия от работодателя или смена на день.
    """
    if v.source == direct.SOURCE or v.shift_date or not v.city:
        return []
    kinds = [k for k in GO_KINDS if k in v.contact]
    if kinds and v.source == "telegram" and CHANNEL_ID.fullmatch(v.id) and SOURCE.fullmatch(source):
        query = urlencode({"s": source, "t": (v.title or "")[:80]})
        return [(kind, f"{GO_URL}/go/{v.id}/{GO_KINDS[kind]}?{query}") for kind in kinds]
    param = start_param(source=source, city=v.city, vacancy_id=v.id, apply=True)
    return [("apply", app_link(param))] if param else []


def profile_link(v: Vacancy, source: str) -> str | None:
    """Ссылка «откликнуться с профилем» рядом с прямыми кнопками связи: отклик на эту вакансию в мини-приложении.

    Прямые кнопки ведут к работодателю мимо приложения, поэтому рядом с ними всегда есть путь, где человек
    за минуту делает профиль и отклик уходит со ссылкой на него. None, если прямых кнопок нет (тогда кнопка
    отклика и так ведёт в приложение) или ссылка не помещается в 64 знака Telegram. Метка источника —
    source + «pf»: воронка видит, откуда пришли за профилем.
    """
    if not any(kind != "apply" for kind, _ in reply_buttons(v, source)):
        return None
    param = start_param(source=source + "pf", city=v.city, vacancy_id=v.id, apply=True)
    return app_link(param) if param else None

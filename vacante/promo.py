"""Реклама мини-приложения vacante в своих Telegram-каналах.

Раз в день в каждый работающий канал выходит пост со ссылкой на мини-приложение (по-русски и по-казахски),
и в каждом канале закреплён пост с той же ссылкой. Ссылка t.me/vacantekz_bot?startapp=<город> открывает
приложение сразу с вакансиями этого города (web_app-кнопки в каналах Telegram не разрешает, url-кнопка
с startapp открывает Main Mini App бота).

В каналах включено автоудаление постов через 30 дней, поэтому закреплённый пост раз в PIN_REFRESH
публикуем заново, закрепляем новый и открепляем старый. Что опубликовано, хранится в posted.json
(город → "app_on" и "app_pin").
"""

from __future__ import annotations

import html
import logging
from collections.abc import Callable
from datetime import date, datetime, timedelta

import httpx

from vacante import direct
from vacante.models import Vacancy
from vacante.site import i18n
from vacante.site.build import city_heading, city_name

log = logging.getLogger(__name__)

HOUR = 13  # ежедневный пост в 13:00 по Казахстану: обеденный перерыв, утренние вакансии уже вышли
PIN_REFRESH = timedelta(days=21)  # раньше 30-дневного автоудаления
PIN_RETRY = timedelta(hours=6)  # не смогли закрепить (у бота нет права): пробуем снова не чаще
FRESH = timedelta(hours=48)

# (канал, текст в HTML-разметке, кнопки (текст, ссылка)) → message_id
ButtonSender = Callable[[str, str, list[tuple[str, str]]], "int | None"]
Pinner = Callable[[str, int, bool], None]  # (канал, message_id, закрепить или открепить)


def app_url(city: str) -> str:
    return f"https://t.me/{direct.BOT_USERNAME}?startapp={city}"


def buttons(city: str) -> list[tuple[str, str]]:
    return [("📱 Открыть приложение · Қосымшаны ашу", app_url(city))]


def _where(city: str) -> tuple[str, str]:
    """(«Алматы», «Алматыдағы»)."""
    return city_name(city, "ru"), i18n.CITIES_KK_IN.get(city, city_name(city, "kk"))


# Тексты ежедневного поста меняются по дням, чтобы подписчики не видели одно и то же.
# {n} — число свежих вакансий города, {ru}/{kk} — город по-русски и «Алматыдағы».
DAILY = [
    ("📱 <b>Все вакансии {ru_in} — в одном приложении</b>\n\n"
     "{n_ru}Листайте как ленту: вправо — нравится, влево — дальше. "
     "Фильтр «рядом с домом», смены и подработка, отклик в один тап.\n\n"
     "🇰🇿 <b>{kk} барлық бос орын — бір қосымшада</b>\n"
     "{n_kk}Таспа сияқты парақтаңыз: оңға — ұнайды, солға — келесі. "
     "«Үйге жақын» сүзгісі, ауысымдар мен қосымша жұмыс, бір түртумен өтініш."),
    ("⚡ <b>Ищете работу быстрее?</b>\n\n"
     "В приложении vacante — анкета с видео-кружком, которую работодатель смотрит за 10 секунд, "
     "и список откликов с напоминаниями: никого не забудете и не пропустите.\n\n"
     "🇰🇿 <b>Жұмысты тезірек тапқыңыз келе ме?</b>\n"
     "vacante қосымшасында — бейне-дөңгелегі бар анкета, жұмыс беруші оны 10 секундта көреді, "
     "және еске салғышы бар өтініштер тізімі."),
    ("📍 <b>Работа рядом с домом {ru_in}</b>\n\n"
     "{n_ru}Укажите свой адрес в приложении — покажем вакансии поближе, чтобы не тратить час на дорогу.\n\n"
     "🇰🇿 <b>{kk} үйге жақын жұмыс</b>\n"
     "{n_kk}Қосымшада мекенжайыңызды көрсетіңіз — жақын бос орындарды көрсетеміз."),
    ("🔥 <b>Свежие вакансии каждый час</b>\n\n"
     "Приложение vacante собирает объявления из Telegram-каналов, hh.kz и от работодателей. "
     "Бесплатно, без регистрации, прямо в Telegram.\n\n"
     "🇰🇿 <b>Жаңа бос орындар әр сағат сайын</b>\n"
     "vacante қосымшасы Telegram-арналардан, hh.kz-тен және жұмыс берушілерден хабарландыруларды жинайды. "
     "Тегін, тіркелусіз, тікелей Telegram-да."),
]

PINNED = ("📌 <b>Приложение vacante — работа {ru_in}</b>\n"
          "Все вакансии города, фильтр «рядом с домом», смены и подработка, анкета с видео-кружком "
          "и отклик в один тап. Бесплатно, прямо в Telegram 👇\n\n"
          "📌 <b>vacante қосымшасы — {kk} жұмыс</b>\n"
          "Қаланың барлық бос орны, «үйге жақын» сүзгісі, ауысымдар, бейне-дөңгелегі бар анкета "
          "және бір түртумен өтініш. Тегін, тікелей Telegram-да 👇")

TAGS = "\n\nПерешлите другу, который ищет работу 🙌 · Жұмыс іздеген досыңызға жіберіңіз"


def _ru_in(city: str) -> str:
    return city_heading(city, "ru").removeprefix("Работа ")  # «в Алматы»


def fresh_count(vacancies: list[Vacancy], city: str, now: datetime) -> int:
    cutoff = (now - FRESH).isoformat()
    return sum(1 for v in vacancies if v.city == city and v.posted_at >= cutoff)


def daily_text(city: str, day: date, count: int) -> str:
    ru, kk = _where(city)
    template = DAILY[day.toordinal() % len(DAILY)]
    n_ru = f"За двое суток — <b>{count}</b> новых вакансий. " if count >= 10 else ""
    n_kk = f"Екі тәулікте — <b>{count}</b> жаңа бос орын. " if count >= 10 else ""
    return template.format(ru_in=html.escape(_ru_in(city)), ru=html.escape(ru), kk=html.escape(kk),
                           n_ru=n_ru, n_kk=n_kk) + TAGS


def pinned_text(city: str) -> str:
    _, kk = _where(city)
    return PINNED.format(ru_in=html.escape(_ru_in(city)), kk=html.escape(kk))


def run_channel(chat: str, city: str, state: dict, now: datetime, local_now: datetime, count: int,
                send: ButtonSender, pin: Pinner | None, stats: dict) -> None:
    """Ежедневный пост и закреп для одного канала; state — posted.json[город]."""
    today = local_now.date().isoformat()
    if local_now.hour >= HOUR and state.get("app_on") != today:
        state["app_on"] = today  # и при ошибке: второй раз за день не пробуем
        try:
            send(chat, daily_text(city, local_now.date(), count), buttons(city))
            stats["app"] = stats.get("app", 0) + 1
        except (httpx.HTTPError, RuntimeError) as exc:
            log.warning("пост о приложении в %s: %s", chat, exc if isinstance(exc, RuntimeError) else type(exc).__name__)
    if pin is not None:
        _keep_pinned(chat, city, state, now, send, pin, stats)


def _keep_pinned(chat: str, city: str, state: dict, now: datetime, send: ButtonSender, pin: Pinner,
                 stats: dict) -> None:
    cur = state.get("app_pin")
    old = cur is not None and now - datetime.fromisoformat(cur["at"]) >= PIN_REFRESH
    if cur and not old and not cur.get("pinned"):
        # Пост есть, но закрепить не вышло (боту не дали право «Закрепление/Редактирование»): пробуем снова
        if now - datetime.fromisoformat(cur.get("tried_at") or cur["at"]) < PIN_RETRY:
            return
        cur["tried_at"] = now.isoformat(timespec="seconds")
        if _try_pin(chat, cur["message_id"], pin):
            cur["pinned"] = True
            stats["app_pinned"] = stats.get("app_pinned", 0) + 1
        return
    if cur and not old:
        return
    try:
        message_id = send(chat, pinned_text(city), buttons(city))
    except (httpx.HTTPError, RuntimeError) as exc:
        log.warning("закреп о приложении в %s: %s", chat, exc if isinstance(exc, RuntimeError) else type(exc).__name__)
        return
    if not message_id:
        return
    at = now.isoformat(timespec="seconds")
    pinned = _try_pin(chat, message_id, pin)
    state["app_pin"] = {"message_id": message_id, "at": at, "pinned": pinned, "tried_at": at}
    if pinned:
        stats["app_pinned"] = stats.get("app_pinned", 0) + 1
    if cur and cur.get("pinned"):  # старый закреп снимаем; сам пост удалит автоудаление
        try:
            pin(chat, cur["message_id"], False)
        except (httpx.HTTPError, RuntimeError) as exc:
            log.info("открепить старый пост о приложении в %s: %s", chat,
                     exc if isinstance(exc, RuntimeError) else type(exc).__name__)


def _try_pin(chat: str, message_id: int, pin: Pinner) -> bool:
    try:
        pin(chat, message_id, True)
        return True
    except (httpx.HTTPError, RuntimeError) as exc:
        log.warning("закрепить пост о приложении в %s: %s", chat, exc if isinstance(exc, RuntimeError) else type(exc).__name__)
        return False

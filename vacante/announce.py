"""Разовое объявление во все свои Telegram-каналы: текст с кнопкой в мини-приложение.

Запускается вручную (workflow «Объявление в каналы»): `python -m vacante announce --name <имя> --data-dir data`.
Каждое объявление выходит в канале один раз: что уже вышло, записано в posted.json (город → "announced"),
поэтому повторный запуск дошлёт только туда, куда не дошло. Кнопка ведёт в ленту города с меткой
источника, чтобы воронка в админке показала, сколько людей пришло с объявления.
"""

from __future__ import annotations

import html
import logging

import httpx

from vacante import launch
from vacante.promo import ButtonSender, _ru_in, _where

log = logging.getLogger(__name__)

# имя → (метка источника для воронки, текст в HTML-разметке, подпись кнопки).
# {ru_in} — «в Алматы», {kk} — «Алматыдағы».
ANNOUNCEMENTS: dict[str, tuple[str, str, str]] = {
    "apply-button": (
        "live",
        "✉️ <b>Отклик на вакансию — в один тап</b>\n\n"
        "Под вакансиями в этом канале появилась кнопка «✉️ Откликнуться». Она открывает вакансию в приложении "
        "vacante: сделайте профиль за минуту — имя и профессия — и отправьте работодателю готовое сообщение "
        "со ссылкой на профиль в WhatsApp или Telegram. Приложение покажет, когда ваш профиль открыли.\n\n"
        "Попробуйте на любой вакансии {ru_in} 👇\n\n"
        "🇰🇿 <b>Бос орынға өтініш — бір түртумен</b>\n"
        "Осы арнадағы бос орындардың астында «✉️ Откликнуться» батырмасы пайда болды. Ол бос орынды vacante "
        "қосымшасында ашады: бір минутта профиль жасаңыз — атыңыз бен мамандығыңыз — және жұмыс берушіге "
        "профиліңізге сілтемесі бар дайын хабарды WhatsApp немесе Telegram арқылы жіберіңіз.\n\n"
        "{kk} кез келген бос орында байқап көріңіз 👇",
        "📱 Открыть вакансии · Бос орындарды ашу",
    ),
}


def text_for(name: str, city: str) -> str:
    _, kk = _where(city)
    return ANNOUNCEMENTS[name][1].format(ru_in=html.escape(_ru_in(city)), kk=html.escape(kk))


def buttons_for(name: str, city: str) -> list[tuple[str, str]]:
    source, _, label = ANNOUNCEMENTS[name]
    return [(label, launch.app_link(launch.start_param(source=source, city=city) or city))]


def run(name: str, posted: dict, live: dict[str, str], send: ButtonSender) -> dict:
    """Публикует объявление в каналы, где оно ещё не выходило. posted — posted.json, меняется на месте."""
    if name not in ANNOUNCEMENTS:
        raise ValueError(f"нет объявления «{name}»: есть {', '.join(sorted(ANNOUNCEMENTS))}")
    stats = {"sent": 0, "skipped": 0, "failed": 0}
    for city, chat in live.items():
        state = posted.setdefault(city, {})
        done = state.setdefault("announced", [])
        if name in done:
            stats["skipped"] += 1
            continue
        try:
            send(chat, text_for(name, city), buttons_for(name, city))
        except (httpx.HTTPError, RuntimeError) as exc:
            stats["failed"] += 1
            log.warning("объявление «%s» в %s: %s", name, chat, exc if isinstance(exc, RuntimeError) else type(exc).__name__)
            continue
        done.append(name)
        stats["sent"] += 1
    return stats

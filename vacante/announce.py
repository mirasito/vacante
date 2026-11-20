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

from vacante import launch, tg
from vacante.promo import ButtonSender, _ru_in, _where

log = logging.getLogger(__name__)

# имя → (текст в HTML-разметке, кнопки). {ru_in} — «в Алматы», {kk} — «Алматыдағы».
# Кнопка — (подпись, ссылка): "app:<метка>" — лента города в мини-приложении с меткой источника для воронки,
# иначе обычная ссылка, {city} в ней заменяется на город.
BOT_POST = "https://t.me/vacantekz_bot?start=post_ch"  # анкета работодателя, jobs.came_from = 'channel'
EMPLOYERS_PAGE = ("https://vacante.kz/rabotodatelyam/?utm_source=telegram&utm_medium=channel"
                  "&utm_campaign={name}&utm_content={city}")

ANNOUNCEMENTS: dict[str, tuple[str, list[tuple[str, str]]]] = {
    "apply-button": (
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
        [("📱 Открыть вакансии · Бос орындарды ашу", "app:live")],
    ),
    "employers-paste": (
        "🏢 <b>Ищете сотрудников {ru_in}? Вакансия — за минуту</b>\n\n"
        "Анкету заполнять не нужно. Нажмите «⚡ Разместить вакансию» и просто вставьте в бот:\n"
        "• текст своего объявления — как вы пишете его в WhatsApp или в чатах,\n"
        "• или ссылку на вакансию с hh.kz.\n\n"
        "Бот сам найдёт должность, зарплату, график и адрес и спросит только то, чего не хватает. "
        "Вакансия выйдет в этом канале, на сайте vacante.kz и в приложении, "
        "а отклики кандидатов придут вам прямо в Telegram.\n\n"
        "💰 Базовое размещение — <b>990 ₸</b>. «Про» — <b>3 990 ₸</b>: 14 дней в топе города, закреп в канале, "
        "повтор через неделю и рассылка подписчикам.\n\n"
        "🇰🇿 <b>{kk} бизнесіңізге қызметкер керек пе? Бос орын — бір минутта</b>\n"
        "Сауалнама толтырудың қажеті жоқ. «⚡ Разместить вакансию» батырмасын басып, ботқа хабарландыру "
        "мәтінін немесе hh.kz сілтемесін қойыңыз. Бот лауазымды, жалақыны, кестені және мекенжайды өзі табады, "
        "жетіспейтінін ғана сұрайды. Өтініштер тікелей Telegram-ға келеді.\n"
        "Базалық — <b>990 ₸</b>, «Про» — <b>3 990 ₸</b>.",
        [("⚡ Разместить вакансию · Орналастыру", BOT_POST),
         ("💼 Тарифы и кабинет · Тарифтер", EMPLOYERS_PAGE)],
    ),
}


def text_for(name: str, city: str) -> str:
    _, kk = _where(city)
    return ANNOUNCEMENTS[name][0].format(ru_in=html.escape(_ru_in(city)), kk=html.escape(kk))


def buttons_for(name: str, city: str) -> list[tuple[str, str]]:
    buttons = []
    for label, url in ANNOUNCEMENTS[name][1]:
        if url.startswith("app:"):
            url = launch.app_link(launch.start_param(source=url[4:], city=city) or city)
        else:
            url = url.format(city=city, name=name.replace("-", "_"))
        buttons.append((label, url))
    return buttons


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
            log.warning("объявление «%s» в %s: %s", name, chat, tg.error_text(exc))
            continue
        done.append(name)
        stats["sent"] += 1
    return stats

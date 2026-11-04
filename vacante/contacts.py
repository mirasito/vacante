"""Какими способами можно откликнуться на пост из канала: WhatsApp, звонок, Telegram.

Сами номера и имена в открытые данные не попадают: разбор вырезает их из текста (parse.clean_text).
Здесь только виды контактов. По ним приложение сразу показывает нужные кнопки, а номер сервер
в Казахстане берёт из исходного поста в момент отклика и не хранит (server/src/contacts.ts).
"""

from __future__ import annotations

import re

# Те же номера, что вырезает разбор: +7 701 123 45 67, 8(701)1234567, 701-123-45-67
PHONE = re.compile(r"(?:\+?[78][\s(-]*)?\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}")
WHATSAPP = re.compile(r"whats\s?app|watsap|ватс?ап|вацап|уатсап|вотсап|wa\.me/|api\.whatsapp\.com/send", re.I)
# @hr_almaty или t.me/hr_almaty: человек или бот, которому можно написать
USERNAME = re.compile(r"(?:(?<![\w.@/])@|(?:https?://)?t\.me/)([A-Za-z]\w{3,31})(?![\w/])")
# Строки-подписи каналов («Подписывайтесь @almaty_jobs», «По вопросам рекламы @admin»): не контакт работодателя
PROMO = re.compile(r"подпис|разместить ваканси|размещени\w* ваканси|реклам|наш канал|поделись|жазыл", re.I)

KINDS = ("whatsapp", "phone", "telegram")


def kinds(text: str, links: list[str] | tuple[str, ...] = (), channel: str = "") -> list[str]:
    """Виды контактов в посте по порядку KINDS. links — адреса ссылок поста (в тексте их не видно)."""
    lines = [line for line in text.splitlines() if not PROMO.search(line)]
    body = "\n".join(lines)
    hrefs = [h for h in links if not h.lower().startswith(("https://t.me/" + channel.lower() + "/", "tg://"))] if channel else list(links)
    found = set()
    if WHATSAPP.search(body) or any(re.search(r"wa\.me/|api\.whatsapp\.com/send", h, re.I) for h in hrefs):
        found.add("whatsapp")
    if PHONE.search(body) or any(h.lower().startswith("tel:") or re.search(r"wa\.me/\d", h) for h in hrefs):
        found.add("phone")
    names = {m.group(1).lower() for m in USERNAME.finditer(body)}
    names |= {m.group(1).lower() for h in hrefs for m in [re.match(r"https?://t\.me/([A-Za-z]\w{3,31})/?$", h)] if m}
    names.discard(channel.lower())
    names -= {"s", "share", "joinchat", "addlist", "proxy", "vacantekz_bot"}
    if names:
        found.add("telegram")
    return [k for k in KINDS if k in found]

"""Свои Telegram-каналы vacante по городам и какие из них уже работают.

Список каналов — в config/own_channels.yaml. Новый канал включается сам: раз в час автопостинг
спрашивает Telegram (getChatMember), админ ли бот в канале и может ли публиковать, и записывает ответ
в channels.json ветки data. По этому файлу сайт показывает кнопку подписки, а сбор кладёт вакансии
города в очередь агента-модератора.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from datetime import datetime, timedelta
from pathlib import Path

import httpx
import yaml

log = logging.getLogger(__name__)

CONFIG = Path("config/own_channels.yaml")
STATE = "channels.json"
# Ещё не заработавший канал проверяем каждый час, работающий — раз в сутки (если бота сняли с админов)
RECHECK_OFF = timedelta(minutes=55)
RECHECK_ON = timedelta(hours=24)

# Проверка канала: True — бот админ и может публиковать, False — нет, None — не удалось узнать
Checker = Callable[[str], "bool | None"]


def load(config: Path = CONFIG) -> dict[str, dict]:
    """Город → {"chat": "@username", "always": bool}."""
    if not config.exists():  # запуск не из корня репозитория
        return {"astana": {"chat": "@vacanteastana", "always": True},
                "almaty": {"chat": "@vacantealmaty", "always": True}}
    raw = yaml.safe_load(config.read_text("utf-8"))["channels"]
    return {city: {"chat": "@" + c["username"].lstrip("@"), "always": bool(c.get("always"))}
            for city, c in raw.items()}


ALL = load()


def _read(data_dir: Path) -> dict:
    try:
        return json.loads((data_dir / STATE).read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def live(data_dir: Path, channels: dict[str, dict] | None = None) -> dict[str, str]:
    """Работающие каналы: город → @username."""
    channels = ALL if channels is None else channels
    state = _read(data_dir)
    return {city: c["chat"] for city, c in channels.items()
            if c["always"] or state.get(c["chat"], {}).get("live")}


def refresh(data_dir: Path, check: Checker, now: datetime, channels: dict[str, dict] | None = None) -> dict[str, str]:
    """Проверяет каналы, которым пора, сохраняет channels.json и возвращает работающие."""
    channels = ALL if channels is None else channels
    state = _read(data_dir)
    changed = False
    for city, c in channels.items():
        if c["always"]:
            continue
        prev = state.get(c["chat"], {})
        wait = RECHECK_ON if prev.get("live") else RECHECK_OFF
        if prev.get("checked_at") and now - datetime.fromisoformat(prev["checked_at"]) < wait:
            continue
        ok = check(c["chat"])
        if ok is None:  # Telegram не ответил: оставляем как было
            continue
        if ok and not prev.get("live"):
            log.info("канал %s (%s) заработал", c["chat"], city)
        state[c["chat"]] = {"city": city, "live": ok, "checked_at": now.isoformat(timespec="seconds"),
                            **({"since": prev.get("since") or now.isoformat(timespec="seconds")} if ok else {})}
        changed = True
    if changed:
        (data_dir / STATE).write_text(json.dumps(state, ensure_ascii=False, indent=1) + "\n", "utf-8")
    return live(data_dir, channels)


def telegram_checker(client: httpx.Client, token: str) -> Checker:
    bot_id = int(token.split(":", 1)[0])

    def check(chat: str) -> bool | None:
        try:
            r = client.post(f"https://api.telegram.org/bot{token}/getChatMember",
                            data={"chat_id": chat, "user_id": bot_id})
        except httpx.HTTPError:
            return None
        if r.status_code in (400, 403):  # канала нет или бот в нём не состоит
            return False
        if r.status_code != 200:
            return None
        member = r.json().get("result", {})
        return member.get("status") == "administrator" and bool(member.get("can_post_messages"))
    return check

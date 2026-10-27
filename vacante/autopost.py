"""Автопостинг свежих вакансий в свои Telegram-каналы vacante.

Каждый час после сбора: если для канала подошло время, выбираем лучшую свежую вакансию
его города и публикуем её с кнопкой на карточку сайта. Что уже опубликовано, хранится
в posted.json рядом с вакансиями.
"""

from __future__ import annotations

import html
import json
import logging
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from vacante.models import Vacancy
from vacante.site.build import salary_label
from vacante.store import load_vacancies

log = logging.getLogger(__name__)

# Свои каналы по городам.
CHANNELS = {"astana": "@vacanteastana", "almaty": "@vacantealmaty"}
LOCAL = timezone(timedelta(hours=5))  # весь Казахстан живёт по UTC+5
POST_HOURS = range(9, 21)  # публикуем с 9:00 до 20:59 по местному времени
MIN_GAP = timedelta(hours=3)  # так выходит 4 поста в день: около 9, 12, 15 и 18 часов
FRESH = timedelta(hours=48)
KEEP = 500  # сколько опубликованных id помнить на канал
HASHTAGS = {"horeca": "#общепит", "retail": "#продажи", "warehouse": "#склад", "delivery": "#доставка",
            "service": "#сервис", "construction": "#стройка", "callcenter": "#колцентр", "other": ""}

Sender = Callable[[str, str, str], None]


def load_posted(data_dir: Path) -> dict:
    path = data_dir / "posted.json"
    return json.loads(path.read_text("utf-8")) if path.exists() else {}


def save_posted(data_dir: Path, posted: dict) -> None:
    (data_dir / "posted.json").write_text(json.dumps(posted, ensure_ascii=False, indent=1) + "\n", "utf-8")


def is_due(last_at: str | None, now: datetime) -> bool:
    if now.astimezone(LOCAL).hour not in POST_HOURS:
        return False
    return last_at is None or now - datetime.fromisoformat(last_at) >= MIN_GAP


def _score(v: Vacancy) -> float:
    return (3 * (v.salary_min is not None or v.salary_max is not None) + 2 * bool(v.employer)
            + bool(v.schedule) + 0.5 * min(len(v.perks), 2) + (v.category != "other"))


def pick(vacancies: list[Vacancy], city: str, state: dict, now: datetime) -> Vacancy | None:
    """Лучшая свежая неопубликованная вакансия города; должности последних постов не повторяем."""
    seen = set(state.get("ids", []))
    recent_titles = set(state.get("titles", [])[-3:])
    cutoff = (now - FRESH).isoformat()
    candidates = [
        v for v in vacancies
        if v.city == city and v.id not in seen and v.posted_at >= cutoff and v.title not in recent_titles
    ]
    return max(candidates, key=lambda v: (_score(v), v.posted_at), default=None)


def format_post(v: Vacancy) -> str:
    """Текст поста в HTML-разметке Telegram: только главное, полный текст на карточке сайта."""
    e = html.escape
    lines = [f"<b>{e(v.title)}</b>"]
    salary = salary_label(v)
    if salary:
        lines.append(f"💰 {e(salary)}")
    if v.schedule:
        lines.append(f"🕒 {e(v.schedule)}")
    if v.employer:
        lines.append(f"🏢 {e(v.employer)}")
    if v.perks:
        lines.append(f"✅ {e(' · '.join(v.perks))}")
    lines += ["", f"#вакансии {HASHTAGS[v.category]}".strip()]
    return "\n".join(lines)


def telegram_sender(client: httpx.Client, token: str) -> Sender:
    def send(chat: str, text: str, url: str) -> None:
        r = client.post(f"https://api.telegram.org/bot{token}/sendMessage", json={
            "chat_id": chat,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
            "reply_markup": {"inline_keyboard": [[{"text": "Подробнее и откликнуться", "url": url}]]},
        })
        if r.status_code != 200:
            # В логах только ответ Telegram: адрес запроса содержит токен
            json_body = r.headers.get("content-type", "").startswith("application/json")
            raise RuntimeError(f"Telegram {r.status_code}: {r.json().get('description') if json_body else r.reason_phrase}")
    return send


def run(data_dir: Path, base_url: str, send: Sender, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    base_url = base_url.rstrip("/")
    vacancies = load_vacancies(data_dir)
    posted = load_posted(data_dir)
    stats = {"posted": 0, "failed": 0}
    for city, chat in CHANNELS.items():
        state = posted.setdefault(city, {"ids": [], "titles": [], "last_at": None})
        if not is_due(state["last_at"], now):
            continue
        v = pick(vacancies, city, state, now)
        if v is None:
            continue
        try:
            send(chat, format_post(v), f"{base_url}/v/{v.id}/")
        except (httpx.HTTPError, RuntimeError) as exc:
            log.warning("канал %s: %s", chat, exc if isinstance(exc, RuntimeError) else type(exc).__name__)
            stats["failed"] += 1
            continue
        state["ids"] = (state["ids"] + [v.id])[-KEEP:]
        state["titles"] = (state["titles"] + [v.title])[-KEEP:]
        state["last_at"] = now.isoformat()
        stats["posted"] += 1
    save_posted(data_dir, posted)
    return stats

"""Автопостинг свежих вакансий в свои Telegram-каналы vacante.

Каждый час после сбора: если для канала подошло время, выбираем лучшую свежую вакансию
его города и публикуем картинку-карточку (должность, заведение, адрес, зарплата) с подписью
и кнопками «Подробнее» и «2ГИС». Что уже опубликовано, хранится в posted.json рядом с вакансиями.
"""

from __future__ import annotations

import html
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from vacante import card, direct
from vacante.models import Vacancy
from vacante.site.build import twogis_url
from vacante.store import load_vacancies

log = logging.getLogger(__name__)

# Свои каналы по городам.
CHANNELS = {"astana": "@vacanteastana", "almaty": "@vacantealmaty"}
LOCAL = timezone(timedelta(hours=5))  # весь Казахстан живёт по UTC+5
POST_HOURS = range(8, 22)  # публикуем с 8:00 до 21:59 по местному времени
# Вакансии от работодателей (через бота) публикуем сразу после одобрения, вне общей очереди,
# но не ночью: с 22:00 до 8:00 ждут утра
DIRECT_HOURS = range(8, 22)
MAX_DIRECT = 3  # за один запуск в канал, остальные следующим часом
# По посту на каждом часовом запуске, около 14 в день на канал. Чуть меньше часа, потому что
# запуск может сдвинуться на несколько минут.
MIN_GAP = timedelta(minutes=50)
FRESH = timedelta(hours=48)
KEEP = 500  # сколько опубликованных id помнить на канал
HASHTAGS = {"horeca": "#общепит", "retail": "#продажи", "warehouse": "#склад", "delivery": "#доставка",
            "service": "#сервис", "construction": "#стройка", "callcenter": "#колцентр", "other": ""}


@dataclass
class Post:
    caption: str  # HTML-разметка Telegram
    photo: bytes  # PNG
    buttons: list[tuple[str, str]]  # (текст, ссылка)


Sender = Callable[[str, Post], None]


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
    # Вакансии, размещённые работодателем через бота, идут в канал первыми
    return (10 * (v.source == direct.SOURCE) + 3 * (v.salary_min is not None or v.salary_max is not None)
            + 2 * bool(v.employer) + bool(v.schedule) + 0.5 * min(len(v.perks), 2) + (v.category != "other"))


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


def direct_due(vacancies: list[Vacancy], city: str, state: dict, now: datetime) -> list[Vacancy]:
    """Свежие одобренные вакансии от работодателей, которые ещё не выходили в канал города."""
    if now.astimezone(LOCAL).hour not in DIRECT_HOURS:
        return []
    seen = set(state.get("ids", []))
    cutoff = (now - FRESH).isoformat()
    fresh = [v for v in vacancies
             if v.source == direct.SOURCE and v.city == city and v.id not in seen and v.posted_at >= cutoff]
    return sorted(fresh, key=lambda v: v.posted_at)[:MAX_DIRECT]


def _lower_first(title: str) -> str:
    return title[:1].lower() + title[1:] if title[1:2].islower() else title  # «SMM-менеджер» не трогаем


def format_caption(v: Vacancy) -> str:
    """Подпись под картинкой: на картинке должность, заведение, адрес и зарплата, здесь остальное."""
    e = html.escape
    titles = [_lower_first(t) for t in v.title.split(", ")]
    need = "требуется" if len(titles) == 1 else "требуются"
    what = f"<b>{e(', '.join(titles))}</b>"
    lines = [f"В {e(v.employer)} {need} {what}" if v.employer else f"{need.capitalize()} {what}"]
    if v.schedule:
        lines.append(f"🕒 График: {e(v.schedule)}")
    if v.perks:
        lines.append(f"✅ {e(' · '.join(v.perks))}")
    lines += ["", f"#вакансии {HASHTAGS[v.category]}".strip()]
    return "\n".join(lines)


def make_post(v: Vacancy, base_url: str) -> Post:
    buttons = [("👆 Подробнее", f"{base_url}/v/{v.id}/")]
    if v.source == direct.SOURCE:
        buttons.append(("✉️ Откликнуться", v.source_url))
    if url := twogis_url(v):
        buttons.append(("📍 Открыть в 2ГИС", url))
    return Post(format_caption(v), card.render(v), buttons)


def telegram_sender(client: httpx.Client, token: str) -> Sender:
    def send(chat: str, post: Post) -> None:
        keys = [{"text": text, "url": url} for text, url in post.buttons]
        markup = {"inline_keyboard": [keys[i:i + 2] for i in range(0, len(keys), 2)]}  # по две кнопки в ряд
        r = client.post(
            f"https://api.telegram.org/bot{token}/sendPhoto",
            data={"chat_id": chat, "caption": post.caption, "parse_mode": "HTML",
                  "reply_markup": json.dumps(markup, ensure_ascii=False)},
            files={"photo": ("vacancy.png", post.photo, "image/png")},
        )
        if r.status_code != 200:
            # В логах только ответ Telegram: адрес запроса содержит токен
            json_body = r.headers.get("content-type", "").startswith("application/json")
            raise RuntimeError(f"Telegram {r.status_code}: {r.json().get('description') if json_body else r.reason_phrase}")
    return send


def awaiting_review(data_dir: Path) -> set[str]:
    """Вакансии работодателей, которые агент-модератор ещё не проверил (очередь moderation.json).

    Модератор может опубликовать вакансию кнопкой как есть: на сайте она появится сразу,
    а в канал выйдет только после того, как агент её оформит."""
    try:
        queue = json.loads((data_dir / "moderation.json").read_text("utf-8"))
    except (OSError, ValueError):
        return set()
    return {f"{direct.SOURCE}-{job['id']}" for job in queue.get("jobs", [])}


def run(data_dir: Path, base_url: str, send: Sender, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    base_url = base_url.rstrip("/")
    held = awaiting_review(data_dir)
    vacancies = [v for v in load_vacancies(data_dir) if v.id not in held]
    posted = load_posted(data_dir)
    stats = {"posted": 0, "failed": 0}
    for city, chat in CHANNELS.items():
        state = posted.setdefault(city, {"ids": [], "titles": [], "last_at": None})
        # Сначала вакансии от работодателей: они не ждут слота и не сдвигают общую очередь
        for v in direct_due(vacancies, city, state, now):
            if _publish(chat, v, base_url, send, state, stats):
                stats["direct"] = stats.get("direct", 0) + 1
        if not is_due(state["last_at"], now):
            continue
        v = pick(vacancies, city, state, now)
        if v is not None and _publish(chat, v, base_url, send, state, stats):
            state["last_at"] = now.isoformat()
    save_posted(data_dir, posted)
    return stats


def _publish(chat: str, v: Vacancy, base_url: str, send: Sender, state: dict, stats: dict) -> bool:
    try:
        send(chat, make_post(v, base_url))
    except (httpx.HTTPError, RuntimeError) as exc:
        log.warning("канал %s: %s", chat, exc if isinstance(exc, RuntimeError) else type(exc).__name__)
        stats["failed"] += 1
        return False
    state["ids"] = (state["ids"] + [v.id])[-KEEP:]
    state["titles"] = (state["titles"] + [v.title])[-KEEP:]
    stats["posted"] += 1
    return True

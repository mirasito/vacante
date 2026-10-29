"""Автопостинг свежих вакансий в свои Telegram-каналы vacante.

Каждый час после сбора: если для канала подошло время, выбираем лучшую свежую вакансию
его города и публикуем картинку-карточку (аватар заведения, должность, заведение, адрес, зарплата)
с подписью и кнопками «Подробнее», «2ГИС» и Instagram заведения. Что уже опубликовано, хранится в posted.json рядом с вакансиями.
Вакансии из чужих каналов перед постом проверяет и оформляет агент-модератор (vacante.review).
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

from vacante import card, direct, review, venues
from vacante.models import Vacancy
from vacante.site.build import instagram_url, twogis_url
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
# post.yml после каждого часового обновления публикует серию из 10 постов раз в 5,5 минуты, около 140 в день
# на канал. Интервал меньше 5,5 минуты, чтобы серия не теряла пост из-за сдвига, и защищает от двойного
# поста, если два запуска совпали.
MIN_GAP = timedelta(minutes=4)
FRESH = timedelta(hours=48)
KEEP = 500  # сколько опубликованных id помнить на канал
# Сколько ближайших кандидатов на пост в каждом городе агент проверяет за раз: каждый час с запасом
# на серию из 10 постов и на отклонённые
REVIEW_PER_CITY = 16
# Агенту даём новых кандидатов, только пока одобренных и ещё не вышедших меньше этого числа: иначе очередь
# растёт быстрее, чем выходят посты, и раньше одобренные вакансии вытесняются свежими и не выходят никогда
BACKLOG = 20
# Одно заведение выходит в канал не чаще раза в трое суток: работодатели размещают одну и ту же вакансию
# в нескольких каналах и с разными словами, а у WeFind на hh.kz десятки почти одинаковых вакансий грузчиков
EMPLOYER_GAP = timedelta(days=3)
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


def _score(v: Vacancy, known: set[str]) -> float:
    # Вакансии, размещённые работодателем через бота, идут в канал первыми; с аватаром заведения чуть выше
    return (10 * (v.source == direct.SOURCE) + 3 * (v.salary_min is not None or v.salary_max is not None)
            + 2 * bool(v.employer) + (v.id in known) + bool(v.schedule) + 0.5 * min(len(v.perks), 2)
            + (v.category != "other"))


def dup_keys(v: Vacancy) -> set[str]:
    """По чему узнаём повтор: заведение, а без него должность с зарплатой."""
    if v.employer and v.employer.strip():
        return {venues.key(v.employer, v.city)}
    if v.salary_min is not None or v.salary_max is not None:
        return {f"{v.city}:{v.title.lower()}:{v.salary_min}:{v.salary_max}"}
    return set()


def _recent(state: dict, now: datetime) -> set[str]:
    cutoff = (now - EMPLOYER_GAP).isoformat()
    return {k for k, at in state.get("employers", {}).items() if at >= cutoff}


def _remember(state: dict, keys: set[str], now: datetime) -> None:
    employers = state.setdefault("employers", {})
    for k in keys:
        employers[k] = now.isoformat()
    cutoff = (now - EMPLOYER_GAP).isoformat()
    state["employers"] = {k: at for k, at in employers.items() if at >= cutoff}


def _backfill(state: dict, vacancies: list[Vacancy], keys_of: dict[str, set[str]], now: datetime) -> None:
    """Каналы, опубликованные до учёта заведений: их заведения считаем вышедшими во время последнего поста."""
    if "employers" in state:
        return
    at = datetime.fromisoformat(state["last_at"]) if state.get("last_at") else now
    by_id = {v.id: v for v in vacancies}
    keys = set().union(*(keys_of.get(i) or dup_keys(by_id[i]) for i in state.get("ids", []) if i in by_id))
    state["employers"] = {}
    _remember(state, keys, at)


def pick(vacancies: list[Vacancy], city: str, state: dict, now: datetime,
         known: set[str] = frozenset(), keys_of: dict[str, set[str]] | None = None,
         approved_at: dict[str, str] | None = None) -> Vacancy | None:
    """Лучшая свежая неопубликованная вакансия города.

    Должности последних постов и заведения, вышедшие за последние трое суток, не повторяем. Из равных
    по полноте первой идёт та, что агент одобрил раньше, без проверки агента — самая свежая."""
    keys_of = keys_of or {}
    approved_at = approved_at or {}
    seen = set(state.get("ids", []))
    recent_titles = set(state.get("titles", [])[-3:])
    recent = _recent(state, now)
    cutoff = (now - FRESH).isoformat()
    candidates = [
        v for v in vacancies
        if v.city == city and v.id not in seen and v.posted_at >= cutoff and v.title not in recent_titles
        and not (keys_of.get(v.id) or dup_keys(v)) & recent
    ]

    def order(v: Vacancy) -> tuple:
        at = approved_at.get(v.id)
        # Одобренные раньше выше; без одобрения (вакансии из бота, или агент ещё не включён) — свежие выше
        return (_score(v, known), at is None, -datetime.fromisoformat(at).timestamp() if at else v.posted_at)

    return max(candidates, key=order, default=None)


def top_key(v: Vacancy) -> str:
    """Отметка в posted.json, что оплаченное «🔥 Срочно» вышло в канал; продление даёт новый пост."""
    return f"{v.id}@{v.top_until}"


def direct_due(vacancies: list[Vacancy], city: str, state: dict, now: datetime) -> list[Vacancy]:
    """Вакансии от работодателей для канала города: свежие одобренные, которые ещё не выходили,
    и оплатившие «🔥 Срочно», которые ещё не выходили с этой пометкой."""
    if now.astimezone(LOCAL).hour not in DIRECT_HOURS:
        return []
    seen, tops = set(state.get("ids", [])), set(state.get("tops", []))
    cutoff = (now - FRESH).isoformat()
    due = [v for v in vacancies if v.source == direct.SOURCE and v.city == city
           and ((v.id not in seen and v.posted_at >= cutoff) or (v.is_top(now) and top_key(v) not in tops))]
    return sorted(due, key=lambda v: (not v.is_top(now), v.posted_at))[:MAX_DIRECT]


def _lower_first(title: str) -> str:
    return title[:1].lower() + title[1:] if title[1:2].islower() else title  # «SMM-менеджер» не трогаем


def format_caption(v: Vacancy, urgent: bool = False) -> str:
    """Подпись под картинкой: на картинке должность, заведение, адрес и зарплата, здесь остальное."""
    e = html.escape
    titles = [_lower_first(t) for t in v.title.split(", ")]
    need = "требуется" if len(titles) == 1 else "требуются"
    what = f"<b>{e(', '.join(titles))}</b>"
    lines = ["🔥 <b>Срочно!</b>"] if urgent else []
    lines.append(f"В {e(v.employer)} {need} {what}" if v.employer else f"{need.capitalize()} {what}")
    if v.schedule:
        lines.append(f"🕒 График: {e(v.schedule)}")
    if v.perks:
        lines.append(f"✅ {e(' · '.join(v.perks))}")
    lines += ["", f"#вакансии {HASHTAGS[v.category]}".strip()]
    return "\n".join(lines)


def make_post(v: Vacancy, base_url: str, venue: dict | None = None, avatar: bytes | None = None,
              urgent: bool = False) -> Post:
    buttons = [("👆 Подробнее", f"{base_url}/v/{v.id}/")]
    if v.source == direct.SOURCE:
        buttons.append(("✉️ Откликнуться", v.source_url))
    if url := twogis_url(v):
        buttons.append(("📍 Открыть в 2ГИС", url))
    if url := instagram_url(venue):
        buttons.append(("📸 Instagram", url))
    return Post(format_caption(v, urgent), card.render(v, avatar), buttons)


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


def checked_by_agent(vacancies: list[Vacancy], reviews: dict | None) -> list[Vacancy]:
    """Что можно постить: вакансии работодателей и одобренные агентом вакансии из каналов, с его правками.

    Пока агент ещё ничего не проверял (post_reviews.json нет), постим как раньше, без проверки."""
    if reviews is None:
        return vacancies
    return [review.reviewed(v, reviews.get(v.id)) for v in vacancies
            if v.source == direct.SOURCE or reviews.get(v.id, {}).get("verdict") == "approve"]


def review_queue(vacancies: list[Vacancy], posted: dict, reviews: dict, now: datetime,
                 known: set[str] = frozenset()) -> list[Vacancy]:
    """Ближайшие кандидаты на пост в каждом городе, которые агент ещё не проверял, в порядке очереди.

    Повторы уже вышедших или уже одобренных заведений агенту не показываем, и новых кандидатов не даём,
    пока одобренных и ещё не вышедших хватает на пару часов постов."""
    cutoff = (now - FRESH).isoformat()
    out = []
    for city in CHANNELS:
        state = posted.get(city, {})
        seen = set(state.get("ids", []))
        fresh = [v for v in vacancies if v.city == city and v.source != direct.SOURCE and v.id not in seen
                 and v.posted_at >= cutoff]
        taken = _recent(state, now)
        waiting = 0
        for v in fresh:
            if reviews.get(v.id, {}).get("verdict") == "approve" and not dup_keys(v) & taken:
                waiting += 1
                taken |= dup_keys(v)
        room = min(REVIEW_PER_CITY, BACKLOG - waiting)
        for v in sorted(fresh, key=lambda v: (_score(v, known), v.posted_at), reverse=True):
            if room <= 0:
                break
            if v.id in reviews or dup_keys(v) & taken:
                continue
            out.append(v)
            taken |= dup_keys(v)
            room -= 1
    return out


def write_review_queue(data_dir: Path, now: datetime | None = None) -> int:
    """Выкладывает очередь для агента в post_queue.json; возвращает её длину."""
    now = now or datetime.now(timezone.utc)
    vacancies = load_vacancies(data_dir)
    table = venues.load(data_dir)
    known = {v.id for v in vacancies if (venue := venues.lookup(table, v)) and venue.get("avatar")}
    items = review_queue(vacancies, load_posted(data_dir), review.load(data_dir) or {}, now, known)
    payload = {"updated_at": now.isoformat(timespec="seconds"), "vacancies": [review.queue_item(v) for v in items]}
    (data_dir / review.QUEUE).write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", "utf-8")
    return len(items)


def run(data_dir: Path, base_url: str, send: Sender, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    base_url = base_url.rstrip("/")
    held = awaiting_review(data_dir)
    original = {v.id: v for v in load_vacancies(data_dir) if v.id not in held}
    vacancies = checked_by_agent(list(original.values()), review.load(data_dir))
    posted = load_posted(data_dir)
    table = venues.load(data_dir)
    # Заведение ищем по названию из исходного объявления: агент мог оформить его иначе («DINO FEST» → «Рестопарк «Dino Fest»»)
    venue_of = {v.id: venues.lookup(table, v) for v in original.values()}
    known = {i for i, venue in venue_of.items() if venue and venue.get("avatar")}
    # Повторы ищем и по исходному названию заведения, и по оформленному агентом
    keys_of = {v.id: dup_keys(v) | dup_keys(original[v.id]) for v in vacancies}
    reviews = review.load(data_dir) or {}
    approved_at = {i: r["at"] for i, r in reviews.items() if r.get("verdict") == "approve" and r.get("at")}
    stats = {"posted": 0, "failed": 0}
    for city, chat in CHANNELS.items():
        state = posted.setdefault(city, {"ids": [], "titles": [], "last_at": None})
        _backfill(state, list(original.values()), keys_of, now)
        # Сначала вакансии от работодателей: они не ждут слота и не сдвигают общую очередь
        for v in direct_due(vacancies, city, state, now):
            urgent = v.is_top(now)
            if _publish(chat, v, base_url, send, state, stats, data_dir, venue_of.get(v.id), urgent):
                stats["direct"] = stats.get("direct", 0) + 1
                _remember(state, keys_of[v.id], now)
                if urgent:
                    state["tops"] = (state.get("tops", []) + [top_key(v)])[-KEEP:]
        if not is_due(state["last_at"], now):
            continue
        v = pick(vacancies, city, state, now, known, keys_of, approved_at)
        if v is not None and _publish(chat, v, base_url, send, state, stats, data_dir, venue_of.get(v.id)):
            state["last_at"] = now.isoformat()
            _remember(state, keys_of[v.id], now)
    save_posted(data_dir, posted)
    return stats


def _publish(chat: str, v: Vacancy, base_url: str, send: Sender, state: dict, stats: dict,
             data_dir: Path, venue: dict | None, urgent: bool = False) -> bool:
    try:
        send(chat, make_post(v, base_url, venue, venues.avatar_bytes(data_dir, venue), urgent))
    except (httpx.HTTPError, RuntimeError) as exc:
        log.warning("канал %s: %s", chat, exc if isinstance(exc, RuntimeError) else type(exc).__name__)
        stats["failed"] += 1
        return False
    state["ids"] = (state["ids"] + [v.id])[-KEEP:]
    state["titles"] = (state["titles"] + [v.title])[-KEEP:]
    stats["posted"] += 1
    return True

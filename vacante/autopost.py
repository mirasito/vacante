"""Автопостинг свежих вакансий в свои Telegram-каналы vacante.

В каждый канал в день выходит утренняя подборка и до семи лучших вакансий, по одной в слот (SLOTS):
картинка-карточка (аватар заведения, должность, заведение, адрес, зарплата) с подписью и кнопками отклика,
«Подробнее», «2ГИС» и Instagram заведения. Канал может быть посвящён одной сфере (config/own_channels.yaml,
only): тогда из очереди в него идут только её вакансии. Что уже опубликовано, хранится в posted.json рядом
с вакансиями. Вакансии из чужих каналов перед постом проверяет и оформляет агент-модератор (vacante.review).
"""

from __future__ import annotations

import html
import json
import logging
from collections import Counter
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from vacante import card, channels, direct, launch, promo, reach, review, shifts, tg, venues
from vacante.localtime import LOCAL
from vacante.models import Vacancy
from vacante.site.build import city_heading, city_name, instagram_url, salary_label, twogis_url
from vacante.store import load_vacancies

log = logging.getLogger(__name__)

# Свои каналы по городам (config/own_channels.yaml); постим только в уже работающие, см. vacante.channels
CHANNELS = {city: c["chat"] for city, c in channels.ALL.items()}
POST_HOURS = range(8, 22)  # публикуем с 8:00 до 21:59 по местному времени
# Вакансии от работодателей (через бота) публикуем сразу после одобрения, вне общей очереди,
# но не ночью: с 22:00 до 8:00 ждут утра
DIRECT_HOURS = range(8, 22)
MAX_DIRECT = 3  # за один запуск в канал, остальные следующим часом
# Часы по местному времени, с которых начинается слот поста из очереди: в слот выходит одна лучшая вакансия,
# до семи в день. Слот длится до начала следующего; пропущенный (нечего публиковать, не было запуска) не
# навёрстывается. post.yml запускает автопостинг каждые пять минут, поэтому пост выходит в начале слота.
# Раньше пост выходил раз в 5,5 минуты, около 140 в день: такой канал не читают.
SLOTS = (9, 10, 12, 14, 16, 18, 20)
# Утренняя подборка: один пост со списком лучших вакансий дня. Если в 8 утра вакансий мало, ждём до 11
DIGEST_HOURS = range(8, 11)
DIGEST_MAX = 8
DIGEST_MIN = 4  # меньше четырёх вакансий: подборку в этот день не публикуем
DIGEST_SOURCE = "tgdg"  # метка источника в ссылках подборки: воронка отличает её от постов-карточек («tg»)
SPHERE_WORK = {"horeca": "Работа в общепите"}  # заголовок подборки в канале одной сферы
MONTHS = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября",
          "ноября", "декабря")
FRESH = timedelta(hours=48)
KEEP = 500  # сколько опубликованных id помнить на канал
# Сколько ближайших кандидатов на пост в каждом городе агент проверяет за раз, с запасом на отклонённые
REVIEW_PER_CITY = 16
# Агенту даём новых кандидатов, только пока одобренных и ещё не вышедших меньше этого числа: в день выходит
# до 15 вакансий (подборка и слоты), и из запаса в 20 одобренных есть из чего выбрать лучшие
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


Sender = Callable[[str, Post], "int | None"]  # возвращает message_id поста, если Telegram его сообщил
TextSender = Callable[[str, str], None]  # (канал, текст в HTML-разметке)

# Вечерняя подборка «⚡ Подработка и смены на завтра» в каждый канал, раз в день в этот час по Казахстану
SHIFTS_HOUR = 19
SHIFTS_MAX = 10
SHIFTS_MIN = 3  # меньше трёх смен: подборку в этот день не публикуем
Pinner = Callable[[str, int, bool], None]  # (канал, message_id, закрепить или открепить)


def load_posted(data_dir: Path) -> dict:
    path = data_dir / "posted.json"
    return json.loads(path.read_text("utf-8")) if path.exists() else {}


def save_posted(data_dir: Path, posted: dict) -> None:
    (data_dir / "posted.json").write_text(json.dumps(posted, ensure_ascii=False, indent=1) + "\n", "utf-8")


def slot(now: datetime) -> str | None:
    """Слот поста из очереди, который идёт сейчас: «2026-11-16T09». None ночью и до первого слота дня."""
    local = now.astimezone(LOCAL)
    started = [h for h in SLOTS if h <= local.hour]
    if local.hour not in POST_HOURS or not started:
        return None
    return f"{local.date().isoformat()}T{started[-1]:02d}"


def fits(v: Vacancy, city: str) -> bool:
    """Вакансия для канала этого города. В канал одной сферы из очереди идут только её вакансии;
    вакансии от работодателей (и оплаченные «Срочно») выходят в канал своего города в любой сфере."""
    only = channels.sphere(city)
    return v.city == city and (only is None or v.category == only or v.source == direct.SOURCE)


def _score(v: Vacancy, known: set[str]) -> float:
    # Вакансии, размещённые работодателем через бота, идут в канал первыми. Дальше — с контактом WhatsApp или
    # Telegram: только там отклик из приложения несёт ссылку на профиль (звонок её не передаёт, на hh.kz она
    # лишь копируется); внутри каждой группы выше более полные. С аватаром заведения чуть выше
    return (100 * (v.source == direct.SOURCE) + 10 * bool({"whatsapp", "telegram"} & set(v.contact))
            + 3 * (v.salary_min is not None or v.salary_max is not None)
            + 2 * bool(v.employer) + (v.id in known) + bool(v.schedule) + 0.5 * min(len(v.perks), 2)
            + (v.category != "other"))


def filled(v: Vacancy) -> bool:
    """Есть что показать на карточке поста: зарплата, заведение или адрес. Без всего этого карточка в канале
    выходит пустой (только должность и город), такие вакансии остаются на сайте, но в канал не идут."""
    return (v.salary_min is not None or v.salary_max is not None or bool((v.employer or "").strip())
            or bool((v.address or "").strip()))


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


def ranked(vacancies: list[Vacancy], city: str, state: dict, now: datetime,
           known: set[str] = frozenset(), keys_of: dict[str, set[str]] | None = None,
           approved_at: dict[str, str] | None = None) -> list[Vacancy]:
    """Свежие неопубликованные вакансии для канала города, лучшие первыми.

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
        if fits(v, city) and v.id not in seen and v.posted_at >= cutoff and v.title not in recent_titles
        and filled(v)
        and not (keys_of.get(v.id) or dup_keys(v)) & recent
    ]

    def order(v: Vacancy) -> tuple:
        at = approved_at.get(v.id)
        # Одобренные раньше выше; без одобрения (вакансии из бота, или агент ещё не включён) — свежие выше
        return (_score(v, known), at is None, -datetime.fromisoformat(at).timestamp() if at else v.posted_at)

    return sorted(candidates, key=order, reverse=True)


def pick(vacancies: list[Vacancy], city: str, state: dict, now: datetime,
         known: set[str] = frozenset(), keys_of: dict[str, set[str]] | None = None,
         approved_at: dict[str, str] | None = None) -> Vacancy | None:
    """Лучшая свежая неопубликованная вакансия для канала города (см. ranked)."""
    return next(iter(ranked(vacancies, city, state, now, known, keys_of, approved_at)), None)


def digest_items(best: list[Vacancy], keys_of: dict[str, set[str]] | None = None) -> list[Vacancy]:
    """Вакансии утренней подборки из списка ranked: разные заведения, одна должность не больше двух раз.
    Вакансии от работодателей в подборку не берём: им обещан отдельный пост."""
    keys_of = keys_of or {}
    out, taken, titles = [], set(), Counter()
    for v in best:
        keys = keys_of.get(v.id) or dup_keys(v)
        if v.source == direct.SOURCE or keys & taken or titles[v.title] >= 2:
            continue
        out.append(v)
        taken |= keys
        titles[v.title] += 1
        if len(out) == DIGEST_MAX:
            break
    return out


def digest_text(items: list[Vacancy], city: str, base_url: str, now: datetime) -> str:
    """Утренняя подборка: должность ссылкой на эту вакансию в мини-приложении, заведение и зарплата."""
    e = html.escape
    local = now.astimezone(LOCAL)
    only = channels.sphere(city)
    where = city_heading(city, "ru").removeprefix("Работа ")  # «в Алматы»
    lines = [f"☀️ <b>{SPHERE_WORK.get(only, 'Работа')} {e(where)}: {local.day} {MONTHS[local.month - 1]}</b>", ""]
    for v in items:
        param = launch.start_param(source=DIGEST_SOURCE, city=city, vacancy_id=v.id)
        url = launch.app_link(param) if param else f"{base_url}/v/{v.id}/"
        facts = [e(v.employer)] if v.employer else []
        if pay := salary_label(v):
            facts.append(e(pay))
        lines.append(f'• <a href="{url}">{e(v.title)}</a>' + (f" · {' · '.join(facts)}" if facts else ""))
    lines += ["", "Нажмите на должность: вакансия откроется в приложении, откликнуться можно сразу.",
              "Перешлите другу, который ищет работу 🙌", "", f"#вакансии {HASHTAGS.get(only, '')}".strip()]
    return "\n".join(lines)


def digest_buttons(city: str) -> list[tuple[str, str]]:
    param = launch.start_param(source=DIGEST_SOURCE, city=city)
    return [(f"📱 Все вакансии · {city_name(city, 'ru')}", launch.app_link(param or city))]


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
    else:
        # Вакансия из чужого источника: одна кнопка отклика, она открывает окно отклика в мини-приложении.
        # Там человек делает профиль и пишет работодателю в WhatsApp или Telegram со ссылкой на него
        if url := launch.apply_link(v, launch.OWN_CHANNELS):
            buttons.insert(0, ("✉️ Откликнуться", url))
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
            tg.url(token, "sendPhoto"),
            data={"chat_id": chat, "caption": post.caption, "parse_mode": "HTML",
                  "reply_markup": json.dumps(markup, ensure_ascii=False)},
            files={"photo": ("vacancy.png", post.photo, "image/png")},
        )
        tg.check(r)
        return r.json().get("result", {}).get("message_id")
    return send


def telegram_pinner(client: httpx.Client, token: str) -> Pinner:
    """Закрепляет пост «🔥 Срочно» в канале без уведомления подписчиков и открепляет его после срока.
    Боту нужно право администратора канала «Редактирование сообщений»."""
    def pin(chat: str, message_id: int, on: bool) -> None:
        method, body = ("pinChatMessage", {"disable_notification": True}) if on else ("unpinChatMessage", {})
        tg.check(client.post(tg.url(token, method),
                           json={"chat_id": chat, "message_id": message_id, **body}))
    return pin


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
                 known: set[str] = frozenset(), cities: Iterable[str] | None = None) -> list[Vacancy]:
    """Ближайшие кандидаты на пост в каждом городе, которые агент ещё не проверял, в порядке очереди.

    В канал одной сферы — только её вакансии. Повторы уже вышедших или уже одобренных заведений агенту
    не показываем, и новых кандидатов не даём, пока одобренных и ещё не вышедших хватает на день постов."""
    cutoff = (now - FRESH).isoformat()
    out = []
    # По умолчанию — каналы, которые работают всегда (Астана и Алматы)
    for city in ([c for c, ch in channels.ALL.items() if ch["always"]] if cities is None else cities):
        state = posted.get(city, {})
        seen = set(state.get("ids", []))
        fresh = [v for v in vacancies if fits(v, city) and v.source != direct.SOURCE and v.id not in seen
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
    items = review_queue(vacancies, load_posted(data_dir), review.load(data_dir) or {}, now, known,
                         channels.live(data_dir))
    payload = {"updated_at": now.isoformat(timespec="seconds"), "vacancies": [review.queue_item(v) for v in items]}
    (data_dir / review.QUEUE).write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", "utf-8")
    return len(items)


def shifts_digest(vacancies: list[Vacancy], city: str, base_url: str, now: datetime,
                  allowed: Callable[[Vacancy], bool]) -> str | None:
    """Текст вечерней подборки смен города или None, если смен мало. allowed: что можно показывать в канале
    (из бота, с hh или проверенное агентом)."""
    e = html.escape
    items = [v for v in shifts.upcoming([v for v in vacancies if v.city == city], now, hours=36, days=1) if allowed(v)]
    if len(items) < SHIFTS_MIN:
        return None
    where = city_heading(city, "ru").removeprefix("Работа ")
    lines = [f"⚡ <b>Подработка и смены {e(where)}: на завтра</b>", ""]
    for v in items[:SHIFTS_MAX]:
        facts = [e(v.employer)] if v.employer else []
        if pay := salary_label(v):
            facts.append(e(pay))
        line = f'• <a href="{base_url}/v/{v.id}/">{e(v.title)}</a>' + (f" · {' · '.join(facts)}" if facts else "")
        if v.shift_date:
            line += f"\n   📅 {shifts.day_label(v.shift_date)}, {e(v.shift_time or '')}"
        lines.append(line)
    lines += ["", f'Все смены и подработка: <a href="{base_url}/{city}/{shifts.SLUG}/">vacante.kz/{city}/{shifts.SLUG}</a>',
              f'Нужны люди на смену? <a href="https://t.me/{direct.BOT_USERNAME}?start=smena">Разместите за минуту</a>',
              "Перешлите другу, который ищет подработку 🙌", "", "#подработка #смены"]
    return "\n".join(lines)


def telegram_text_sender(client: httpx.Client, token: str) -> TextSender:
    def send(chat: str, text: str) -> None:
        tg.check(client.post(tg.url(token, "sendMessage"),
                           json={"chat_id": chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}))
    return send


def telegram_button_sender(client: httpx.Client, token: str) -> promo.ButtonSender:
    """Текстовый пост с url-кнопками (по одной в ряд); возвращает message_id."""
    def send(chat: str, text: str, buttons: list[tuple[str, str]]) -> int | None:
        markup = {"inline_keyboard": [[{"text": t, "url": u}] for t, u in buttons]}
        r = client.post(tg.url(token, "sendMessage"),
                        json={"chat_id": chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True,
                              "reply_markup": markup})
        tg.check(r)
        return r.json().get("result", {}).get("message_id")
    return send


def run(data_dir: Path, base_url: str, send: Sender, now: datetime | None = None, pin: Pinner | None = None,
        live: dict[str, str] | None = None, send_text: TextSender | None = None,
        send_promo: promo.ButtonSender | None = None, meter: reach.Meter | None = None) -> dict:
    """live: работающие каналы, город → @username; по умолчанию из channels.json.
    send_promo: утренняя подборка, пост о мини-приложении раз в день и закреп с ним (vacante.promo).
    meter: раз в день записывает, сколько у канала подписчиков и сколько просмотров у поста (vacante.reach)."""
    now = now or datetime.now(timezone.utc)
    live = channels.live(data_dir) if live is None else live
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
    for city, chat in live.items():
        state = posted.setdefault(city, {"ids": [], "titles": [], "last_at": None})
        _backfill(state, list(original.values()), keys_of, now)
        if pin:
            _unpin_expired(chat, state, original, pin, now, stats)
        # Сначала вакансии от работодателей: они не ждут слота и не сдвигают общую очередь
        for v in direct_due(vacancies, city, state, now):
            urgent = v.is_top(now)
            ok, message_id = _publish(chat, v, base_url, send, state, stats, data_dir, venue_of.get(v.id), urgent)
            if ok:
                stats["direct"] = stats.get("direct", 0) + 1
                _remember(state, keys_of[v.id], now)
                if urgent:
                    state["tops"] = (state.get("tops", []) + [top_key(v)])[-KEEP:]
                    if pin and message_id:
                        _pin(chat, v, message_id, state, pin, stats)
        today = now.astimezone(LOCAL).date().isoformat()
        if send_text and now.astimezone(LOCAL).hour == SHIFTS_HOUR and state.get("shifts_on") != today:
            state["shifts_on"] = today  # и если смен мало: второй раз за вечер не пробуем
            text = shifts_digest(list(original.values()), city, base_url, now,
                                 lambda v: v.source in (direct.SOURCE, "hh") or v.id in approved_at)
            if text:
                try:
                    send_text(chat, text)
                    stats["shifts"] = stats.get("shifts", 0) + 1
                except (httpx.HTTPError, RuntimeError) as exc:
                    log.warning("смены в %s: %s", chat, tg.error_text(exc))
        local_now = now.astimezone(LOCAL)
        if send_promo and local_now.hour in POST_HOURS:
            promo.run_channel(chat, city, state, now, local_now,
                              promo.fresh_count(list(original.values()), city, now), send_promo, pin, stats)
        if meter:
            reach.record(state, chat, now, meter)
        if send_promo and local_now.hour in DIGEST_HOURS and state.get("digest_on") != today:
            items = digest_items(ranked(vacancies, city, state, now, known, keys_of, approved_at), keys_of)
            if len(items) >= DIGEST_MIN:
                state["digest_on"] = today  # и при ошибке: второй раз за утро не пробуем
                try:
                    send_promo(chat, digest_text(items, city, base_url, now), digest_buttons(city))
                except (httpx.HTTPError, RuntimeError) as exc:
                    log.warning("подборка в %s: %s", chat, tg.error_text(exc))
                else:
                    stats["digest"] = stats.get("digest", 0) + 1
                    # Вакансии подборки вышли в канал: отдельным постом их не повторяем
                    state["ids"] = (state["ids"] + [v.id for v in items])[-KEEP:]
                    state["titles"] = (state["titles"] + [v.title for v in items])[-KEEP:]
                    _remember(state, set().union(*(keys_of[v.id] for v in items)), now)
        current = slot(now)
        if current is None or state.get("slot") == current:
            continue
        v = pick(vacancies, city, state, now, known, keys_of, approved_at)
        if v is not None and _publish(chat, v, base_url, send, state, stats, data_dir, venue_of.get(v.id))[0]:
            state["slot"] = current
            state["last_at"] = now.isoformat()
            _remember(state, keys_of[v.id], now)
    save_posted(data_dir, posted)
    return stats


def _publish(chat: str, v: Vacancy, base_url: str, send: Sender, state: dict, stats: dict,
             data_dir: Path, venue: dict | None, urgent: bool = False) -> tuple[bool, int | None]:
    try:
        message_id = send(chat, make_post(v, base_url, venue, venues.avatar_bytes(data_dir, venue), urgent))
    except (httpx.HTTPError, RuntimeError) as exc:
        log.warning("канал %s: %s", chat, tg.error_text(exc))
        stats["failed"] += 1
        return False, None
    state["ids"] = (state["ids"] + [v.id])[-KEEP:]
    state["titles"] = (state["titles"] + [v.title])[-KEEP:]
    stats["posted"] += 1
    return True, message_id


# Пост оплаченного «🔥 Срочно» закреплён в канале до конца срока (posted.json → pins)

def _pin(chat: str, v: Vacancy, message_id: int, state: dict, pin: Pinner, stats: dict) -> None:
    try:
        pin(chat, message_id, True)
    except (httpx.HTTPError, RuntimeError) as exc:
        log.warning("закреп в %s: %s", chat, tg.error_text(exc))
        return
    state.setdefault("pins", []).append({"message_id": message_id, "vacancy": v.id, "until": v.top_until})
    stats["pinned"] = stats.get("pinned", 0) + 1


def _unpin_expired(chat: str, state: dict, live: dict[str, Vacancy], pin: Pinner, now: datetime, stats: dict) -> None:
    """Открепляет посты, у которых кончился оплаченный срок или вакансию закрыли."""
    keep = []
    for p in state.get("pins", []):
        if datetime.fromisoformat(p["until"]) > now and p["vacancy"] in live:
            keep.append(p)
            continue
        try:
            pin(chat, p["message_id"], False)
            stats["unpinned"] = stats.get("unpinned", 0) + 1
        except httpx.HTTPError:
            keep.append(p)  # сеть: попробуем в следующий раз
        except RuntimeError as exc:
            log.warning("открепить в %s: %s", chat, exc)  # пост удалили вручную: забываем
    state["pins"] = keep

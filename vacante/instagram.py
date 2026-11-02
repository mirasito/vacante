"""Подборки вакансий в Instagram vacante: карусель по городу по графику из config/instagram.yaml.

В подборку идут вакансии, которые уже вышли в Telegram-канал города (их отобрал и проверил
агент-модератор, см. vacante.autopost), ещё открытые и не попадавшие в Instagram. Первая карточка —
обложка города, дальше по карточке на вакансию (vacante.card.cover и slide).

Как это работает каждый час (update.yml):
1. Сборка сайта (`plan`) кладёт карточки городов, которым по графику пора, в public/ig/ и план в
   public/ig/plan.json. Instagram забирает картинки только по публичной ссылке, поэтому они на сайте.
2. После выкладки сайта `publish` создаёт контейнеры карусели через Instagram Graph API, публикует их
   и записывает вышедшее в instagram.json ветки data.

Нужно: секрет INSTAGRAM_TOKEN с правами instagram_basic, instagram_content_publish, pages_show_list,
pages_read_engagement и страница Facebook с привязанным бизнес-аккаунтом Instagram. Пока Instagram не
привязан, публикация пропускается (аннотация «Instagram в ленту») и включится сама.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

from vacante import autopost, card, channels, review, venues
from vacante.models import Vacancy
from vacante.site.build import _locative, city_name, salary_label
from vacante.store import load_vacancies

log = logging.getLogger(__name__)

CONFIG = Path("config/instagram.yaml")
STATE = "instagram.json"
PLAN = "ig/plan.json"
LOCAL = autopost.LOCAL
MAX_ITEMS = 9  # и обложка: в карусели не больше 10 карточек
MIN_ITEMS = 2  # меньше двух вакансий — подборку не делаем, ждём следующего раза
FRESH = timedelta(days=3)  # старше трёх суток в подборку не берём
KEEP = 1000  # сколько вышедших id помнить на город
CAPTION_LIMIT = 2200
MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября",
          "ноября", "декабря"]


def load_config(path: Path = CONFIG) -> dict:
    """{"daily_limit": int, "hours": {город: [часы по Казахстану]}}; "*" — каждый час с 9 до 21."""
    if not path.exists():
        return {"daily_limit": 0, "hours": {}}
    raw = yaml.safe_load(path.read_text("utf-8")) or {}

    def hours(value) -> list[int]:
        if value in ("*", "every"):
            return list(range(9, 22))
        return sorted({int(h) for h in value or []})

    default = hours(raw.get("default"))
    cities = {city: hours(h) for city, h in (raw.get("cities") or {}).items()}
    every = {city: cities.get(city, default) for city in channels.ALL}
    return {"daily_limit": int(raw.get("daily_limit", 45)), "hours": every,
            "priority": list(cities) + [c for c in channels.ALL if c not in cities]}


def load_state(data_dir: Path) -> dict:
    try:
        return json.loads((data_dir / STATE).read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(data_dir: Path, state: dict) -> None:
    (data_dir / STATE).write_text(json.dumps(state, ensure_ascii=False, indent=1) + "\n", "utf-8")


def slot(now: datetime) -> str:
    """Час по Казахстану, в который вышла подборка: второй раз за этот час город не публикуем."""
    return now.astimezone(LOCAL).strftime("%Y-%m-%dT%H")


def published_last_day(state: dict, now: datetime) -> int:
    cutoff = (now - timedelta(hours=24)).isoformat()
    return sum(1 for p in state.get("log", []) if p["at"] >= cutoff)


def due_cities(config: dict, state: dict, now: datetime, live: dict[str, str]) -> list[str]:
    """Города, которым по графику пора, в порядке важности (порядок в config/instagram.yaml)."""
    hour, current = now.astimezone(LOCAL).hour, slot(now)
    room = config["daily_limit"] - published_last_day(state, now)
    out = []
    for city in config["priority"]:
        if room <= 0:
            break
        if city in live and hour in config["hours"].get(city, []) and state.get(city, {}).get("slot") != current:
            out.append(city)
            room -= 1
    return out


def pick(city: str, vacancies: dict[str, Vacancy], posted: dict, state: dict, now: datetime) -> list[Vacancy]:
    """Лучшие для подборки: недавно вышедшие в Telegram-канал города, ещё открытые и не бывшие в Instagram,
    по одной от заведения, свежие первыми."""
    seen = set(state.get(city, {}).get("ids", []))
    cutoff = (now - FRESH).isoformat()
    out, taken = [], set()
    for vid in reversed(posted.get(city, {}).get("ids", [])):
        v = vacancies.get(vid)
        if v is None or vid in seen or v.posted_at < cutoff or v.city != city:
            continue
        keys = autopost.dup_keys(v)
        if keys & taken:
            continue
        taken |= keys
        out.append(v)
        if len(out) == MAX_ITEMS:
            break
    return out


def hashtag(text: str) -> str:
    return "#" + "".join(ch for ch in text.lower() if ch.isalnum())


def caption(city: str, items: list[Vacancy], now: datetime, channel: str | None) -> str:
    """Подпись к карусели: список должностей с зарплатой, куда идти откликаться и хэштеги. Ссылки в
    подписи Instagram не кликаются, поэтому адрес сайта текстом и «ссылка в профиле»."""
    name = city_name(city)
    local = now.astimezone(LOCAL)
    where = _locative(city)
    lines = [f"Работа в {where} — свежие вакансии на {local.day} {MONTHS[local.month - 1]} 📍", ""]
    for i, v in enumerate(items, 1):
        line = f"{i}. {v.title}"
        if v.employer:
            line += f" — {v.employer}"
        if pay := salary_label(v):
            line += f" · {pay}"
        lines.append(line)
    lines += ["", "Листайте карточки 👉 Подробности и отклик на vacante.kz (ссылка в профиле)."]
    if channel:
        lines.append(f"Новые вакансии в {where} каждый день в Telegram: {channel}")
    tags = [hashtag(f"вакансии{name}"), hashtag(f"работа{name}"), hashtag(name), "#вакансии", "#работа",
            "#работаказахстан", "#vacantekz"]
    tags += sorted({autopost.HASHTAGS[v.category] for v in items if autopost.HASHTAGS.get(v.category)})
    lines += ["", " ".join(tags)]
    text = "\n".join(lines)
    if len(text) > CAPTION_LIMIT and len(items) > 1:  # длинные названия: короче список
        return caption(city, items[:-1], now, channel)
    return text[:CAPTION_LIMIT]


def plan(data_dir: Path, out: Path, base_url: str, now: datetime | None = None,
         config: dict | None = None) -> list[dict]:
    """Карточки и план подборок на этот час: public/ig/<город>-<час>/N.jpg и public/ig/plan.json."""
    now = now or datetime.now(timezone.utc)
    config = config or load_config()
    base_url = base_url.rstrip("/")
    live = channels.live(data_dir)
    state = load_state(data_dir)
    held = autopost.awaiting_review(data_dir)
    original = {v.id: v for v in load_vacancies(data_dir) if v.id not in held}
    reviews = review.load(data_dir) or {}
    vacancies = {i: review.reviewed(v, reviews.get(i)) for i, v in original.items()}
    posted = autopost.load_posted(data_dir)
    table = venues.load(data_dir)
    local = now.astimezone(LOCAL)
    date_label = f"{local.day} {MONTHS[local.month - 1]}"
    result = []
    for city in due_cities(config, state, now, live):
        items = pick(city, vacancies, posted, state, now)
        if len(items) < MIN_ITEMS:
            log.info("instagram %s: мало новых вакансий (%s), пропускаю", city, len(items))
            continue
        chat = live.get(city)
        tag = hashlib.sha1(",".join(v.id for v in items).encode()).hexdigest()[:8]
        folder = f"ig/{city}-{local:%Y%m%d%H}-{tag}"
        (out / folder).mkdir(parents=True, exist_ok=True)
        images = [card.cover(_locative(city), items, date_label, chat)]
        total = len(items) + 1
        for n, v in enumerate(items, 2):
            venue = venues.lookup(table, original[v.id])
            images.append(card.slide(v, venues.avatar_bytes(data_dir, venue), f"{n}/{total}", chat))
        urls = []
        for n, image in enumerate(images, 1):
            (out / folder / f"{n}.jpg").write_bytes(image)
            urls.append(f"{base_url}/{folder}/{n}.jpg")
        result.append({"city": city, "slot": slot(now), "ids": [v.id for v in items],
                       "caption": caption(city, items, now, chat), "images": urls})
    (out / "ig").mkdir(parents=True, exist_ok=True)
    payload = {"created_at": now.isoformat(timespec="seconds"), "posts": result}
    (out / PLAN).write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", "utf-8")
    return result


class PublishError(RuntimeError):
    pass


class Publisher:
    """Публикация карусели через Instagram Graph API (content publishing)."""

    def __init__(self, api: venues.InstagramAPI, sleep: Callable[[float], None] = time.sleep):
        self.api, self.sleep = api, sleep

    def _post(self, path: str, **params) -> dict:
        r = self.api.client.post(f"{venues.GRAPH}/{path}", data={**params, "access_token": self.api.token})
        body = r.json() if r.headers.get("content-type", "").startswith(("application/json", "text/javascript")) else {}
        if r.status_code != 200:
            error = body.get("error", {})
            raise PublishError(f"Instagram API {r.status_code}: {error.get('message', r.reason_phrase)}"
                               f" (code {error.get('code')}, subcode {error.get('error_subcode')})")
        return body

    def can_publish(self) -> str | None:
        """None, если можно публиковать, иначе почему нельзя."""
        try:
            self.api.user_id()
        except RuntimeError as exc:
            return str(exc)
        scopes = self.api._debug().get("scopes")
        if scopes is not None and "instagram_content_publish" not in scopes:
            return "у токена нет права instagram_content_publish: выберите его при создании токена"
        return None

    def quota_left(self) -> int | None:
        try:
            body = self.api._get(f"{self.api.user_id()}/content_publishing_limit", fields="quota_usage,config")
        except RuntimeError:
            return None
        data = (body.get("data") or [{}])[0]
        total = (data.get("config") or {}).get("quota_total")
        return None if total is None else total - int(data.get("quota_usage") or 0)

    def _wait(self, container: str, tries: int = 10) -> None:
        for _ in range(tries):
            status = self.api._get(container, fields="status_code").get("status_code")
            if status == "FINISHED":
                return
            if status in ("ERROR", "EXPIRED"):
                raise PublishError(f"контейнер {status}")
            self.sleep(6)
        raise PublishError("контейнер не готов за минуту")

    def carousel(self, images: list[str], text: str) -> str:
        """id опубликованного поста."""
        ig = self.api.user_id()
        children = [self._post(f"{ig}/media", image_url=url, is_carousel_item="true")["id"] for url in images]
        for child in children:
            self._wait(child)
        container = self._post(f"{ig}/media", media_type="CAROUSEL", children=",".join(children), caption=text)["id"]
        self._wait(container)
        return self._post(f"{ig}/media_publish", creation_id=container)["id"]


def publish(data_dir: Path, posts: list[dict], publisher: Publisher, now: datetime | None = None,
            config: dict | None = None) -> list[tuple[str, str]]:
    """Публикует подборки из плана и записывает вышедшее в instagram.json. Отчёт для аннотации."""
    now = now or datetime.now(timezone.utc)
    config = config or load_config()
    if not posts:
        return [("подборки", "на этот час нет")]
    if reason := publisher.can_publish():
        return [("instagram", f"пропущено: {reason}")]
    state = load_state(data_dir)
    left = publisher.quota_left()
    room = config["daily_limit"] - published_last_day(state, now)
    report = []
    for p in posts:
        city = p["city"]
        if state.get(city, {}).get("slot") == p["slot"]:
            report.append((city, "уже опубликовано в этот час"))
            continue
        if room <= 0 or (left is not None and left <= 0):
            report.append((city, "пропущено: дневной лимит публикаций"))
            continue
        try:
            media = publisher.carousel(p["images"], p["caption"])
        except (RuntimeError, KeyError) as exc:
            report.append((city, f"error: {exc}"))
            continue
        except Exception as exc:  # сеть: остальные города попробуем
            report.append((city, f"error: {type(exc).__name__}"))
            continue
        city_state = state.setdefault(city, {"ids": []})
        city_state["ids"] = (city_state["ids"] + p["ids"])[-KEEP:]
        city_state.update(slot=p["slot"], last_at=now.isoformat(timespec="seconds"))
        state["log"] = [e for e in state.get("log", []) if e["at"] >= (now - timedelta(days=7)).isoformat()]
        state["log"].append({"at": now.isoformat(timespec="seconds"), "city": city, "media": media,
                             "count": len(p["ids"])})
        save_state(data_dir, state)  # после каждого поста: следующий может упасть
        room -= 1
        if left is not None:
            left -= 1
        report.append((city, f"опубликовано, {len(p['ids'])} вакансий (пост {media})"))
    return report

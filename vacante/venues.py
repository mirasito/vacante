"""Заведения: Instagram и аватар для вакансий, где известен работодатель.

Агент (.claude/skills/find-venues) берёт очередь venues_queue.json, находит Instagram заведения, обычно
через его карточку в 2ГИС, и передаёт итог в workflow venues.yml. Тот записывает venues.json и скачивает
аватар через официальный API Instagram (Business Discovery), если задан секрет INSTAGRAM_TOKEN.
Аватары лежат в ветке data в папке venues/. Сайт показывает аватар и ссылку на Instagram, а картинка поста
в канал рисует аватар на месте значка с буквой.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path

import httpx
from PIL import Image, ImageOps, UnidentifiedImageError

from vacante.models import Vacancy
from vacante.parse import CITIES

log = logging.getLogger(__name__)

FILE = "venues.json"
QUEUE = "venues_queue.json"
AVATARS = "venues"  # папка с аватарами в данных и на сайте
QUEUE_SIZE = 40
AVATAR_SIZE = 320
AVATAR_RETRY = timedelta(days=7)  # аватар не скачался: пробуем снова через неделю
AVATARS_PER_RUN = 60
# found: Instagram найден; none: заведение настоящее, но Instagram не нашёлся; skip: это не название заведения
STATUSES = ("found", "none", "skip")
GRAPH = "https://graph.facebook.com/v23.0"

_HANDLE = re.compile(r"^[a-z0-9._]{1,30}$")
_LEGAL = re.compile(r"^(?:тоо|ип|ооо|ао|too|llp)\s+")

AvatarSource = Callable[[str], bytes | None]


class TokenError(RuntimeError):
    """Токен API не подходит: дальше пробовать бессмысленно."""


def key(name: str, city: str | None) -> str:
    """Ключ заведения: город и название без кавычек, регистра и формы собственности."""
    n = re.sub(r"[«»\"“”„'’]", "", name.lower().replace("ё", "е"))
    n = _LEGAL.sub("", n.strip())
    n = re.sub(r"[^\w&+]+", " ", n).strip()
    return f"{city or 'kz'}:{n}"


def avatar_file(venue_key: str) -> str:
    return hashlib.sha1(venue_key.encode()).hexdigest()[:16] + ".jpg"


def handle(value: str | None) -> str | None:
    """«@dino_fest_almaty», «instagram.com/Dino_fest_almaty/» → «dino_fest_almaty»."""
    if not value:
        return None
    value = value.strip().lower()
    value = re.sub(r"^(?:https?://)?(?:www\.)?(?:instagram\.com|instagr\.am)/", "", value)
    value = value.lstrip("@").split("?")[0].strip("/")
    return value if _HANDLE.match(value) and value not in {"p", "reel", "explore", "accounts"} else None


def load(data_dir: Path) -> dict[str, dict]:
    path = data_dir / FILE
    return json.loads(path.read_text("utf-8")) if path.exists() else {}


def save(data_dir: Path, venues: dict[str, dict]) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / FILE).write_text(json.dumps(dict(sorted(venues.items())), ensure_ascii=False, indent=1) + "\n",
                                 "utf-8")


def lookup(venues: dict[str, dict], v: Vacancy) -> dict | None:
    """Заведение вакансии, если про него что-то известно (Instagram или аватар)."""
    if not v.employer:
        return None
    venue = venues.get(key(v.employer, v.city))
    return venue if venue and (venue.get("instagram") or venue.get("avatar")) else None


def avatar_bytes(data_dir: Path, venue: dict | None) -> bytes | None:
    if not venue or not venue.get("avatar"):
        return None
    path = data_dir / AVATARS / venue["avatar"]
    return path.read_bytes() if path.exists() else None


def queue(vacancies: list[Vacancy], venues: dict[str, dict], now: datetime) -> list[dict]:
    """Заведения, которые агент ещё не искал: сначала с самыми свежими вакансиями, потом с самыми частыми."""
    groups: dict[str, list[Vacancy]] = {}
    for v in vacancies:
        if v.employer and (k := key(v.employer, v.city)) not in venues and k.split(":", 1)[1]:
            groups.setdefault(k, []).append(v)
    fresh = (now - timedelta(hours=48)).isoformat()

    def rank(item: tuple[str, list[Vacancy]]) -> tuple:
        latest = max(v.posted_at for v in item[1])
        return (latest < fresh, -len(item[1]), -datetime.fromisoformat(latest).timestamp())

    items = []
    for k, group in sorted(groups.items(), key=rank)[:QUEUE_SIZE]:
        v = max(group, key=lambda x: x.posted_at)
        items.append({
            "key": k, "name": v.employer, "city": v.city, "city_name": CITIES.get(v.city, ("Казахстан",))[0],
            "vacancies": len(group), "title": v.title, "address": v.address, "text": v.text[:400],
        })
    return items


def write_queue(data_dir: Path, vacancies: list[Vacancy], now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    items = queue(vacancies, load(data_dir), now)
    payload = {"updated_at": now.isoformat(timespec="seconds"), "venues": items}
    (data_dir / QUEUE).write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", "utf-8")
    return len(items)


def save_avatar(data_dir: Path, venue_key: str, image: bytes) -> str:
    """Квадратный JPEG 320×320 из любой картинки; возвращает имя файла в папке venues/."""
    with Image.open(BytesIO(image)) as img:
        img = ImageOps.exif_transpose(img).convert("RGB")
        img = ImageOps.fit(img, (AVATAR_SIZE, AVATAR_SIZE), Image.LANCZOS)
        name = avatar_file(venue_key)
        (data_dir / AVATARS).mkdir(parents=True, exist_ok=True)
        img.save(data_dir / AVATARS / name, "JPEG", quality=86, optimize=True)
    return name


def apply(data_dir: Path, results: list[dict], now: datetime | None = None) -> list[tuple[str, str]]:
    """Записывает находки агента в venues.json. Возвращает [(ключ, итог)] для аннотаций."""
    now = now or datetime.now(timezone.utc)
    venues = load(data_dir)
    names = {item["key"]: item for item in _read_queue(data_dir)}
    report = []
    for r in results:
        k, status = r.get("key"), r.get("status")
        if not isinstance(k, str) or ":" not in k:
            report.append((str(k), "error: нет ключа заведения"))
            continue
        if status not in STATUSES:
            report.append((k, f"error: status должен быть одним из {', '.join(STATUSES)}"))
            continue
        ig = handle(r.get("instagram"))
        if status == "found" and not ig:
            report.append((k, f"error: не похоже на Instagram: {r.get('instagram')!r}"))
            continue
        old = venues.get(k, {})
        known = names.get(k, {})
        venue = {"name": r.get("name") or old.get("name") or known.get("name") or k.split(":", 1)[1],
                 "city": k.split(":", 1)[0], "status": status, "checked_at": now.isoformat(timespec="seconds")}
        if status == "found":
            venue["instagram"] = ig
            if old.get("instagram") == ig and old.get("avatar"):
                venue["avatar"] = old["avatar"]  # тот же аккаунт: аватар уже есть
        elif old.get("avatar"):
            venue["avatar"] = old["avatar"]  # аватар, присланный вручную, не теряем
        if r.get("source"):
            venue["source"] = str(r["source"])[:200]
        venues[k] = venue
        report.append((k, status + (f" @{ig}" if status == "found" else "")))
    save(data_dir, venues)
    return report


def _read_queue(data_dir: Path) -> list[dict]:
    try:
        return json.loads((data_dir / QUEUE).read_text("utf-8")).get("venues", [])
    except (OSError, ValueError):
        return []


def fetch_avatars(data_dir: Path, source: AvatarSource, now: datetime | None = None,
                  limit: int = AVATARS_PER_RUN) -> list[tuple[str, str]]:
    """Скачивает аватары заведений, у которых найден Instagram, а аватара ещё нет."""
    now = now or datetime.now(timezone.utc)
    venues = load(data_dir)
    retry_before = (now - AVATAR_RETRY).isoformat()
    todo = [k for k, v in venues.items()
            if v.get("instagram") and not v.get("avatar") and v.get("avatar_checked_at", "") < retry_before]
    report = []
    for k in todo[:limit]:
        venue = venues[k]
        venue["avatar_checked_at"] = now.isoformat(timespec="seconds")
        try:
            image = source(venue["instagram"])
            if image is None:
                report.append((k, "аватара нет: аккаунт не бизнес, закрыт или не найден"))
                continue
            venue["avatar"] = save_avatar(data_dir, k, image)
            report.append((k, "аватар скачан"))
        except (httpx.HTTPError, RuntimeError, UnidentifiedImageError, OSError) as exc:
            report.append((k, f"error: {exc if isinstance(exc, RuntimeError) else type(exc).__name__}"))
            if isinstance(exc, TokenError):
                venue.pop("avatar_checked_at")  # заведение ни при чём: попробуем, когда токен заработает
                break
    save(data_dir, venues)
    return report


def set_avatar(data_dir: Path, name: str, city: str, image: bytes, instagram: str | None = None,
               now: datetime | None = None) -> str:
    """Аватар вручную, например картинка, которую прислал владелец сайта."""
    now = now or datetime.now(timezone.utc)
    venues = load(data_dir)
    k = key(name, city)
    venue = venues.get(k, {"name": name, "city": city, "status": "found" if instagram else "none"})
    if ig := handle(instagram):
        venue.update(instagram=ig, status="found")
    venue["avatar"] = save_avatar(data_dir, k, image)
    venue["checked_at"] = now.isoformat(timespec="seconds")
    venues[k] = venue
    save(data_dir, venues)
    return k


class InstagramAPI:
    """Официальный API Instagram: Business Discovery отдаёт публичные данные бизнес-аккаунтов.

    Токен: долгий токен страницы Facebook, к которой привязан Instagram vacante (или токен пользователя)
    с правами instagram_basic, pages_show_list, pages_read_engagement. Как получить: README, раздел про заведения.
    """

    def __init__(self, client: httpx.Client, token: str):
        self.client, self.token = client, token
        self._user_id: str | None = None

    def _get(self, path: str, **params) -> dict:
        r = self.client.get(f"{GRAPH}/{path}", params={**params, "access_token": self.token})
        body = r.json() if r.headers.get("content-type", "").startswith(("application/json", "text/javascript")) else {}
        if r.status_code != 200:
            error = body.get("error", {})
            # В ответах API нет токена, но адрес запроса его содержит: в лог только текст ошибки
            message = (f"Instagram API {r.status_code}: {error.get('message', r.reason_phrase)}"
                       f" (code {error.get('code')}, subcode {error.get('error_subcode')})")
            raise (TokenError if error.get("code") in (102, 190) else RuntimeError)(message)
        return body

    def user_id(self) -> str:
        """id Instagram-аккаунта vacante, от имени которого идут запросы."""
        if self._user_id is None:
            me = self._get("me", fields="instagram_business_account")  # токен страницы
            account = me.get("instagram_business_account")
            if not account:  # токен пользователя: ищем среди его страниц
                pages = self._get("me/accounts", fields="instagram_business_account").get("data", [])
                account = next((p["instagram_business_account"] for p in pages
                                if p.get("instagram_business_account")), None)
            if not account:
                raise TokenError("Instagram API: у токена нет страницы с привязанным бизнес-аккаунтом Instagram")
            self._user_id = account["id"]
        return self._user_id

    def avatar(self, username: str) -> bytes | None:
        try:
            body = self._get(self.user_id(), fields=f"business_discovery.username({username}){{profile_picture_url}}")
        except RuntimeError as exc:
            if not isinstance(exc, TokenError) and ("code 110" in str(exc) or "subcode 2207013" in str(exc)):
                return None  # не бизнес-аккаунт или такого нет
            raise
        url = body.get("business_discovery", {}).get("profile_picture_url")
        if not url:
            return None
        r = self.client.get(url)
        r.raise_for_status()
        return r.content

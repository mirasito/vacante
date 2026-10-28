"""Заведения: Instagram, сайт, Telegram и аватар для вакансий, где известен работодатель.

Агент (.claude/skills/find-venues) берёт очередь venues_queue.json, находит ссылки заведения, обычно в его
карточке в 2ГИС, и передаёт итог в workflow venues.yml. Тот записывает venues.json и скачивает аватар
из открытых источников, без обхода чьей-либо защиты:
- Instagram: только через официальный API (Business Discovery), если задан секрет INSTAGRAM_TOKEN;
- Telegram-канал заведения: аватар через Bot API нашим ботом;
- сайт заведения: значок для телефонов (apple-touch-icon) или картинка превью (og:image), если robots.txt
  не запрещает.
Аватары лежат в ветке data в папке venues/. Сайт показывает аватар и ссылки, а картинка поста в канал
рисует аватар на месте значка с буквой.
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
from urllib.parse import quote, urljoin, urlparse
from urllib.robotparser import RobotFileParser

import httpx
from bs4 import BeautifulSoup
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
# found: найдена хотя бы одна ссылка; none: заведение настоящее, но ссылок не нашлось; skip: это не название заведения
STATUSES = ("found", "none", "skip")
# 2: агент записывает не только Instagram, но и сайт и Telegram; 3: ищет через страницу поиска 2ГИС из очереди.
# Заведения, разобранные по старым правилам, он проходит снова.
VERSION = 3
LINKS = ("instagram", "telegram", "website")
GRAPH = "https://graph.facebook.com/v23.0"
USER_AGENT = "vacante.kz/1.0 (+https://vacante.kz)"
MIN_AVATAR = 96  # меньше этого значок будет мутным

_HANDLE = re.compile(r"^[a-z0-9._]{1,30}$")
_TG_HANDLE = re.compile(r"^[a-z][a-z0-9_]{3,31}$")
# Сайтом не считаем соцсети и мессенджеры: у них свои правила и свои ссылки
_NOT_WEBSITE = re.compile(r"(?:^|\.)(?:instagram\.com|facebook\.com|fb\.com|wa\.me|whatsapp\.com|t\.me|"
                          r"telegram\.me|2gis\.\w+|vk\.com|tiktok\.com|youtube\.com)$")
_LEGAL = re.compile(r"^(?:тоо|ип|ооо|ао|too|llp)\s+", re.I)

# Город в адресе страниц 2gis.kz: 2gis.kz/<город>/search/<запрос>
TWOGIS_CITIES = {
    "almaty": "almaty", "astana": "astana", "shymkent": "shymkent", "karaganda": "karaganda", "aktobe": "aktobe",
    "atyrau": "atyrau", "aktau": "aktau", "pavlodar": "pavlodar", "ust-kamenogorsk": "ustkam", "semey": "semey",
    "kostanay": "kostanaj", "uralsk": "uralsk", "taraz": "taraz", "turkestan": "turkestan",
    "petropavlovsk": "petropavlovsk", "kyzylorda": "kyzylorda",
}

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


def telegram_handle(value: str | None) -> str | None:
    """«@dinofest», «https://t.me/dinofest» → «dinofest»; приглашения в закрытые чаты не подходят."""
    if not value:
        return None
    value = value.strip().lower()
    value = re.sub(r"^(?:https?://)?(?:www\.)?(?:t\.me|telegram\.me)/", "", value)
    value = value.lstrip("@").split("?")[0].strip("/")
    return value if _TG_HANDLE.match(value) and value not in {"joinchat", "share", "addstickers"} else None


def website_url(value: str | None) -> str | None:
    """Адрес сайта заведения: https://..., без соцсетей и мессенджеров."""
    if not value:
        return None
    value = value.strip()
    if not re.match(r"^https?://", value, re.I):
        value = "https://" + value
    parts = urlparse(value)
    host = (parts.hostname or "").lower().removeprefix("www.")
    if "." not in host or host.replace(".", "").isdigit() or _NOT_WEBSITE.search(host):
        return None
    return f"{parts.scheme.lower()}://{parts.netloc.lower()}{parts.path or '/'}"


def load(data_dir: Path) -> dict[str, dict]:
    path = data_dir / FILE
    return json.loads(path.read_text("utf-8")) if path.exists() else {}


def save(data_dir: Path, venues: dict[str, dict]) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / FILE).write_text(json.dumps(dict(sorted(venues.items())), ensure_ascii=False, indent=1) + "\n",
                                 "utf-8")


def lookup(venues: dict[str, dict], v: Vacancy) -> dict | None:
    """Заведение вакансии, если про него что-то известно (ссылки или аватар)."""
    if not v.employer:
        return None
    venue = venues.get(key(v.employer, v.city))
    return venue if venue and (venue.get("avatar") or any(venue.get(f) for f in LINKS)) else None


def avatar_bytes(data_dir: Path, venue: dict | None) -> bytes | None:
    if not venue or not venue.get("avatar"):
        return None
    path = data_dir / AVATARS / venue["avatar"]
    return path.read_bytes() if path.exists() else None


def twogis_search(name: str, city: str | None) -> str | None:
    """Страница поиска заведения в 2ГИС его города: в выдаче адреса и ссылки на карточки."""
    slug = TWOGIS_CITIES.get(city or "")
    return f"https://2gis.kz/{slug}/search/{quote(_LEGAL.sub('', name.strip()))}" if slug else None


def queue(vacancies: list[Vacancy], venues: dict[str, dict], now: datetime) -> list[dict]:
    """Заведения, которые агент ещё не искал (или искал по старым правилам): сначала с самыми свежими
    вакансиями, потом с самыми частыми."""
    def todo(k: str) -> bool:
        venue = venues.get(k)
        return venue is None or venue.get("status") != "skip" and venue.get("v", 1) < VERSION

    groups: dict[str, list[Vacancy]] = {}
    for v in vacancies:
        if v.employer and (k := key(v.employer, v.city)).split(":", 1)[1] and todo(k):
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
            "twogis": twogis_search(v.employer, v.city),
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
        links = {"instagram": handle(r.get("instagram")), "telegram": telegram_handle(r.get("telegram")),
                 "website": website_url(r.get("website"))}
        bad = [f for f in LINKS if r.get(f) and not links[f]]
        if bad or status == "found" and not any(links.values()):
            report.append((k, "error: " + (", ".join(f"не похоже на {f}: {r.get(f)!r}" for f in bad)
                                           or "для found нужна хотя бы одна ссылка: instagram, telegram или website")))
            continue
        old = venues.get(k, {})
        known = names.get(k, {})
        venue = {"name": r.get("name") or old.get("name") or known.get("name") or k.split(":", 1)[1],
                 "city": k.split(":", 1)[0], "status": status, "v": VERSION,
                 "checked_at": now.isoformat(timespec="seconds")}
        if status == "found":
            venue.update({f: value for f, value in links.items() if value})
        # Аватар оставляем, если он прислан вручную или его источник не поменялся
        origin = old.get("avatar_source", "manual")
        if old.get("avatar") and (origin == "manual" or old.get(origin) == venue.get(origin)):
            venue.update(avatar=old["avatar"], avatar_source=origin)
        if r.get("source"):
            venue["source"] = str(r["source"])[:200]
        venues[k] = venue
        found = " ".join(f"{f}={venue[f]}" for f in LINKS if venue.get(f))
        report.append((k, status + (f" {found}" if found else "")))
    save(data_dir, venues)
    return report


def _read_queue(data_dir: Path) -> list[dict]:
    try:
        return json.loads((data_dir / QUEUE).read_text("utf-8")).get("venues", [])
    except (OSError, ValueError):
        return []


def fetch_avatars(data_dir: Path, sources: dict[str, AvatarSource], now: datetime | None = None,
                  limit: int = AVATARS_PER_RUN) -> list[tuple[str, str]]:
    """Скачивает аватары заведениям без аватара. sources: {"instagram" | "telegram" | "website": функция},
    пробуются по порядку, первый найденный аватар побеждает."""
    now = now or datetime.now(timezone.utc)
    venues = load(data_dir)
    retry_before = (now - AVATAR_RETRY).isoformat()

    def due(v: dict) -> bool:
        available = {f for f in sources if v.get(f)}
        # Новый источник (например, появился токен Instagram) пробуем сразу, остальные раз в неделю
        return bool(available) and (v.get("avatar_checked_at", "") < retry_before
                                    or not available <= set(v.get("avatar_tried", [])))

    todo = [k for k, v in venues.items() if not v.get("avatar") and due(v)]
    report = []
    broken: dict[str, str] = {}  # источники, у которых не подошёл токен: текст ошибки
    for k in todo[:limit]:
        venue = venues[k]
        venue["avatar_checked_at"] = now.isoformat(timespec="seconds")
        venue["avatar_tried"] = sorted(f for f in sources if venue.get(f) and f not in broken)
        tried = []
        for field, source in sources.items():
            if not venue.get(field):
                continue
            if field in broken:
                tried.append(f"{field}: токен не подошёл")
                continue
            try:
                image = source(venue[field])
                if image is not None:
                    venue["avatar"] = save_avatar(data_dir, k, image)
                    venue["avatar_source"] = field
                    break
                tried.append(f"{field}: нет")
            except TokenError as exc:
                broken[field] = str(exc)
                tried.append(f"{field}: токен не подошёл")
            except (httpx.HTTPError, RuntimeError, UnidentifiedImageError, OSError, ValueError) as exc:
                tried.append(f"{field}: {exc if isinstance(exc, RuntimeError) else type(exc).__name__}")
        if venue.get("avatar"):
            report.append((k, f"аватар скачан ({venue['avatar_source']})"))
        else:
            report.append((k, "аватара нет: " + "; ".join(tried)))
            if any(t.endswith("токен не подошёл") for t in tried):
                venue.pop("avatar_checked_at")  # заведение ни при чём: попробуем, когда токен заработает
                venue.pop("avatar_tried")
    save(data_dir, venues)
    return report + [(field, f"error: {message}") for field, message in broken.items()]


def set_avatar(data_dir: Path, name: str, city: str, image: bytes, instagram: str | None = None,
               now: datetime | None = None) -> str:
    """Аватар вручную, например картинка, которую прислал владелец сайта."""
    now = now or datetime.now(timezone.utc)
    venues = load(data_dir)
    k = key(name, city)
    venue = venues.get(k, {"name": name, "city": city, "status": "found" if instagram else "none"})
    if ig := handle(instagram):
        venue.update(instagram=ig, status="found")
    venue.update(avatar=save_avatar(data_dir, k, image), avatar_source="manual")
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


class TelegramAvatars:
    """Аватар публичного Telegram-канала или группы заведения через Bot API: getChat, getFile."""

    def __init__(self, client: httpx.Client, token: str):
        self.client, self.token = client, token

    def _call(self, method: str, **params) -> dict | None:
        r = self.client.get(f"https://api.telegram.org/bot{self.token}/{method}", params=params)
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        if r.status_code in (401, 404) and body.get("error_code") in (401, 404):
            raise TokenError(f"Telegram {r.status_code}: {body.get('description')}")  # в тексте нет токена
        return body.get("result") if body.get("ok") else None  # «chat not found»: не канал или закрытый

    def avatar(self, username: str) -> bytes | None:
        chat = self._call("getChat", chat_id=f"@{username}")
        photo = (chat or {}).get("photo")
        if not photo:
            return None
        file = self._call("getFile", file_id=photo["big_file_id"])
        if not file or not file.get("file_path"):
            return None
        r = self.client.get(f"https://api.telegram.org/file/bot{self.token}/{file['file_path']}")
        r.raise_for_status()
        return r.content


class WebsiteLogo:
    """Логотип с сайта заведения: значок для телефонов (apple-touch-icon), крупная иконка или картинка превью
    (og:image), если она почти квадратная. Одна страница и картинка на заведение, robots.txt соблюдается."""

    def __init__(self, client: httpx.Client):
        self.client = client
        self._robots: dict[str, RobotFileParser | bool] = {}

    def _allowed(self, url: str) -> bool:
        parts = urlparse(url)
        site = f"{parts.scheme}://{parts.netloc}"
        if site not in self._robots:
            try:
                r = self.client.get(f"{site}/robots.txt", headers={"User-Agent": USER_AGENT})
                if r.status_code == 200:
                    self._robots[site] = RobotFileParser()
                    self._robots[site].parse(r.text.splitlines())
                else:
                    self._robots[site] = r.status_code not in (401, 403)  # нет файла: ограничений нет
            except httpx.HTTPError:
                self._robots[site] = True
        robots = self._robots[site]
        return robots.can_fetch(USER_AGENT, url) if isinstance(robots, RobotFileParser) else robots

    def _image(self, url: str, square: bool) -> bytes | None:
        if not self._allowed(url):
            return None
        r = self.client.get(url, headers={"User-Agent": USER_AGENT})
        if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image/") or len(r.content) > 5_000_000:
            return None
        try:
            with Image.open(BytesIO(r.content)) as img:
                w, h = img.size
        except (UnidentifiedImageError, OSError):
            return None  # например, SVG: Pillow его не читает
        if min(w, h) < MIN_AVATAR or square and not 0.8 <= w / h <= 1.25:
            return None
        return r.content

    def avatar(self, url: str) -> bytes | None:
        if not self._allowed(url):
            return None
        r = self.client.get(url, headers={"User-Agent": USER_AGENT})
        if r.status_code != 200 or "html" not in r.headers.get("content-type", ""):
            return None
        page = BeautifulSoup(r.text[:500_000], "html.parser")
        base = str(r.url)

        def size(tag) -> int:
            m = re.match(r"(\d+)x\d+", tag.get("sizes") or "")
            return int(m[1]) if m else 0

        candidates: list[tuple[str, bool]] = []
        touch = sorted(page.find_all("link", rel=lambda v: v and "apple-touch-icon" in v, href=True), key=size, reverse=True)
        icons = sorted((t for t in page.find_all("link", rel=lambda v: v and "icon" in v, href=True)
                        if size(t) >= MIN_AVATAR), key=size, reverse=True)
        candidates += [(urljoin(base, t["href"]), False) for t in touch + icons]
        candidates += [(urljoin(base, t["content"]), True)
                       for t in page.find_all("meta", property="og:image", content=True)]
        candidates.append((urljoin(base, "/apple-touch-icon.png"), False))
        seen = set()
        for link, square in candidates[:6]:
            if link in seen or not link.startswith(("https://", "http://")):
                continue
            seen.add(link)
            if image := self._image(link, square):
                return image
        return None

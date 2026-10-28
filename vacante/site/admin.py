"""Данные для админки /admin/: источники, решения по постам, автопостинг и подписчики бота.

Страница статическая и не попадает в sitemap. Данные публикуются только зашифрованными паролем
владельца (секрет ADMIN_PASSWORD): AES-GCM с ключом из PBKDF2-SHA256, расшифровывает их сама
страница в браузере. Сюда всё равно идёт только то, что уже публично: ссылки на посты открытых
каналов и их первые строки без телефонов.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path

from vacante.direct import SOURCE as DIRECT
from vacante.journal import ACCEPTED, DUPLICATE, GONE, REJECTED
from vacante.models import Vacancy
from vacante.parse import CATEGORIES, CITIES, REJECT_REASONS

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

SILENT_DAYS = 3  # канал без новых постов дольше этого считаем замолчавшим
RECENT_POSTED = 15


def _read(path: Path) -> dict | None:
    return json.loads(path.read_text("utf-8")) if path.exists() else None


def _city(slug: str | None) -> str:
    return CITIES[slug][0] if slug in CITIES else "Весь Казахстан"


def admin_data(data_dir: Path, vacancies: list[Vacancy], channels: dict[str, str], now: datetime) -> dict:
    """channels: город → ссылка на свой канал vacante (для блока автопостинга)."""
    journal = _read(data_dir / "journal.json") or {"channels": {}, "posts": []}
    posts = journal["posts"]
    live = {v.id: v for v in vacancies}
    day_ago = (now - timedelta(days=1)).isoformat()
    silent_after = (now - timedelta(days=SILENT_DAYS)).isoformat()

    per_channel: dict[str, Counter] = defaultdict(Counter)
    last_post: dict[str, str] = {}
    for p in posts:
        per_channel[p["channel"]][p["status"]] += 1
        last_post[p["channel"]] = max(last_post.get(p["channel"], ""), p["posted_at"])
    on_site = Counter(v.id.rpartition("-")[0] for v in vacancies)

    sources = []
    for name, info in journal["channels"].items():
        c = per_channel[name]
        sources.append({
            "name": name, "city": _city(info.get("city")) if info.get("city") else "—",
            "checked_at": info["checked_at"], "error": info.get("error"),
            "posts": sum(c.values()), "accepted": c[ACCEPTED], "duplicate": c[DUPLICATE],
            "rejected": c[REJECTED] + c[GONE], "on_site": on_site[name.lower()],
            "last_post_at": last_post.get(name),
        })
    sources.sort(key=lambda s: (-s["accepted"], -s["posts"], s["name"].lower()))

    statuses = Counter(p["status"] for p in posts)
    totals = {
        "on_site": len(vacancies),
        "direct": sum(1 for v in vacancies if v.source == DIRECT),
        "new_24h": sum(1 for p in posts if p["status"] == ACCEPTED and p["posted_at"] >= day_ago),
        "posts": len(posts),
        "accepted": statuses[ACCEPTED],
        "duplicate": statuses[DUPLICATE],
        "rejected": statuses[REJECTED] + statuses[GONE],
        "channels": len(sources),
        "errors": sum(1 for s in sources if s["error"]),
        "silent": sum(1 for s in sources if not s["error"] and (s["last_post_at"] or "") < silent_after),
    }
    reasons = Counter(p["reason"] or "gone" for p in posts if p["status"] in (REJECTED, GONE))

    posted = _read(data_dir / "posted.json") or {}
    autopost = []
    for city, url in channels.items():
        state = posted.get(city, {"ids": [], "titles": [], "last_at": None})
        recent = list(zip(state["ids"], state["titles"]))[-RECENT_POSTED:][::-1]
        autopost.append({"city": _city(city), "channel": url, "count": len(state["ids"]), "last_at": state["last_at"],
                         "recent": [{"id": i, "title": t, "live": i in live} for i, t in recent]})

    bot = _read(data_dir / "bot.json")
    if bot:
        bot["subscribers"] = sorted(
            ({"city": _city(row.get("city")), "total": int(row["total"] or 0), "active": int(row["active"] or 0)}
             for row in bot["subscribers"]), key=lambda r: -r["active"])

    return {
        "generated_at": now.isoformat(timespec="seconds"),
        "totals": totals,
        "reasons": [{"code": code, "label": REJECT_REASONS.get(code, "Пропала с сайта"), "count": n}
                    for code, n in reasons.most_common()],
        "by_city": Counter(_city(v.city) for v in vacancies).most_common(),
        "by_category": Counter(CATEGORIES[v.category] for v in vacancies).most_common(),
        "sources": sources,
        "posts": posts,
        "autopost": autopost,
        "bot": bot,
    }


# PBKDF2-SHA256 по рекомендации OWASP: перебор пароля дорогой, а в браузере это меньше секунды
ITERATIONS = 600_000


def _key(password: str, salt: bytes, iterations: int) -> bytes:
    # NFKC: один и тот же пароль, набранный на разных устройствах, даёт одинаковые байты
    return hashlib.pbkdf2_hmac("sha256", unicodedata.normalize("NFKC", password).encode(), salt, iterations, 32)


def seal(payload: dict, password: str) -> dict:
    """Зашифровать данные админки паролем. Формат понимает страница admin.html (WebCrypto)."""
    salt, iv = os.urandom(16), os.urandom(12)
    plain = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    data = AESGCM(_key(password, salt, ITERATIONS)).encrypt(iv, plain, None)  # шифротекст и тег вместе, как в WebCrypto
    b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
    return {"v": 1, "iter": ITERATIONS, "salt": b64(salt), "iv": b64(iv), "data": b64(data)}


def unseal(box: dict, password: str) -> dict:
    """Обратное к seal; неверный пароль даёт cryptography.exceptions.InvalidTag."""
    raw = {k: base64.b64decode(box[k]) for k in ("salt", "iv", "data")}
    plain = AESGCM(_key(password, raw["salt"], box["iter"])).decrypt(raw["iv"], raw["data"], None)
    return json.loads(plain)

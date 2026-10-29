"""Подборки новых вакансий подписчикам бота @vacantekz_bot.

Подписки (город, сферы, условия) хранит сам бот в Cloudflare D1, код бота лежит в bot/.
Каждый час после сбора берём вакансии, которых не было при прошлом запуске, и каждому
подписчику отправляем подходящие одним сообщением. Ночью не пишем: накопленное уйдёт утром.
Какие вакансии уже разосланы, хранится в digest.json рядом с вакансиями.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from vacante.models import Vacancy
from vacante.site.build import bot_item, monthly_pay
from vacante.store import load_vacancies

log = logging.getLogger(__name__)

LOCAL = timezone(timedelta(hours=5))
SEND_HOURS = range(8, 22)  # с 8:00 до 21:59 по времени Казахстана
MAX_ITEMS = 10  # вакансий в одном сообщении, остальные на сайте
SALARY = "salary"  # условие «С зарплатой» в подписке

Sender = Callable[[int, str, list], None]


class Blocked(Exception):
    """Пользователь остановил бота или удалил чат: больше ему не пишем."""


@dataclass
class Subscription:
    chat_id: int
    city: str | None
    categories: list[str]
    perks: list[str]
    min_pay: int

    @classmethod
    def from_row(cls, row: dict) -> Subscription:
        return cls(int(row["chat_id"]), row.get("city") or None,
                   [c for c in (row.get("categories") or "").split(",") if c],
                   [p for p in (row.get("perks") or "").split("|") if p], int(row.get("min_pay") or 0))


def matches(sub: Subscription, v: Vacancy) -> bool:
    pay = monthly_pay(v) or 0
    return ((not sub.city or v.city == sub.city)
            and (not sub.categories or v.category in sub.categories)
            and pay >= sub.min_pay
            and all(pay > 0 if p == SALARY else p in v.perks for p in sub.perks))


def format_digest(hits: list[Vacancy], base_url: str) -> str:
    head = "🆕 Новая вакансия для вас" if len(hits) == 1 else f"🆕 Новые вакансии для вас: {len(hits)}"
    parts = [head] + [bot_item(v, base_url) for v in hits[:MAX_ITEMS]]
    if len(hits) > MAX_ITEMS:
        parts.append(f"Остальные {len(hits) - MAX_ITEMS} на сайте, кнопка ниже.")
    return "\n\n".join(parts)


def buttons(sub: Subscription, base_url: str) -> list:
    site = f"{base_url}/{sub.city}/" if sub.city else f"{base_url}/"
    return [[{"text": "Все вакансии на сайте", "url": site}, {"text": "⚙️ Настроить", "callback_data": "settings"}]]


def run(data_dir: Path, base_url: str, subscriptions: Callable[[], list[Subscription]], send: Sender,
        now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    base_url = base_url.rstrip("/")
    vacancies = load_vacancies(data_dir)
    state_path = data_dir / "digest.json"
    stats = {"new": 0, "sent": 0, "failed": 0, "blocked": []}
    if state_path.exists():
        if now.astimezone(LOCAL).hour not in SEND_HOURS:
            return stats
        seen = set(json.loads(state_path.read_text("utf-8"))["seen"])
        new = sorted((v for v in vacancies if v.id not in seen), key=lambda v: v.posted_at, reverse=True)
        stats["new"] = len(new)
        for sub in subscriptions() if new else []:  # без новых вакансий базу не трогаем
            hits = [v for v in new if matches(sub, v)]
            if not hits:
                continue
            try:
                send(sub.chat_id, format_digest(hits, base_url), buttons(sub, base_url))
            except Blocked:
                stats["blocked"].append(sub.chat_id)
            except (httpx.HTTPError, RuntimeError) as exc:
                log.warning("подборка %s: %s", sub.chat_id, exc if isinstance(exc, RuntimeError) else type(exc).__name__)
                stats["failed"] += 1
            else:
                stats["sent"] += 1
    # При первом запуске просто запоминаем, что уже есть: старые вакансии не рассылаем
    state_path.write_text(json.dumps({"seen": sorted(v.id for v in vacancies)}) + "\n", "utf-8")
    return stats


class D1:
    """Запросы к базе бота в Cloudflare D1 через REST API."""

    def __init__(self, client: httpx.Client, account_id: str, api_token: str, name: str = "vacante-bot"):
        self.client = client
        self.base = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database"
        self.headers = {"Authorization": f"Bearer {api_token}"}
        self.name = name
        self._id: str | None = None

    def database_id(self) -> str | None:
        if self._id is None:
            r = self.client.get(self.base, params={"name": self.name}, headers=self.headers)
            r.raise_for_status()
            found = [db["uuid"] for db in r.json()["result"] if db["name"] == self.name]
            self._id = found[0] if found else None
        return self._id

    def query(self, sql: str, params: list | None = None) -> list[dict]:
        r = self.client.post(f"{self.base}/{self.database_id()}/query", headers=self.headers,
                             json={"sql": sql, "params": params or []})
        r.raise_for_status()
        data = r.json()
        if not data.get("success", True):
            raise RuntimeError(f"D1: {data.get('errors')}")
        return data["result"][0]["results"]

    def subscriptions(self) -> list[Subscription]:
        rows = self.query("SELECT chat_id, city, categories, perks, min_pay FROM subscribers WHERE active = 1")
        return [Subscription.from_row(row) for row in rows]

    def subscriber_counts(self) -> list[dict]:
        """Подписчики по городам для админки, без chat_id: [{city, total, active}]."""
        return self.query("SELECT city, COUNT(*) AS total, SUM(active) AS active FROM subscribers GROUP BY city")

    def approved_jobs(self) -> list[dict]:
        """Вакансии от работодателей, одобренные модератором и не закрытые (vacante.direct)."""
        return self.query("SELECT id, city, title, company, salary, schedule, address, details, approved_at, "
                          "salary_min, salary_max, salary_period, boost_until FROM jobs WHERE status = 'approved'")

    def review_queue(self) -> list[dict]:
        """Что ждёт агента-модератора: вакансии на проверке и опубликованные модератором без оформления."""
        return self.query("SELECT id, status, reviewed_at, created_at, city, title, company, salary, schedule, address, "
                          "details FROM jobs WHERE status = 'pending' OR (status = 'approved' AND reviewed_at IS NULL) "
                          "ORDER BY id")

    def job_counts(self) -> dict:
        """Для админки: вакансии от работодателей по статусам и число откликов."""
        counts = {row["status"]: int(row["n"]) for row in
                  self.query("SELECT status, COUNT(*) AS n FROM jobs WHERE status != 'draft' GROUP BY status")}
        counts["applications"] = int(self.query("SELECT COUNT(*) AS n FROM applications")[0]["n"])
        try:  # оплаты «🔥 Срочно» (миграция 0005)
            paid = self.query("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM payments "
                              "WHERE status = 'confirmed'")[0]
            counts["paid"], counts["revenue"] = int(paid["n"]), int(paid["total"])
        except (httpx.HTTPError, RuntimeError):
            pass
        return counts

    def deactivate(self, chat_ids: list[int]) -> None:
        for chat_id in chat_ids:
            self.query("UPDATE subscribers SET active = 0, updated_at = datetime('now') WHERE chat_id = ?", [chat_id])


def telegram_sender(client: httpx.Client, token: str) -> Sender:
    def send(chat_id: int, text: str, keyboard: list) -> None:
        r = client.post(f"https://api.telegram.org/bot{token}/sendMessage", json={
            "chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True,
            "reply_markup": {"inline_keyboard": keyboard},
        })
        time.sleep(0.05)  # лимит Telegram: не больше 30 сообщений в секунду
        if r.status_code == 403:
            raise Blocked(chat_id)
        if r.status_code != 200:
            # В логах только ответ Telegram: адрес запроса содержит токен
            json_body = r.headers.get("content-type", "").startswith("application/json")
            raise RuntimeError(f"Telegram {r.status_code}: {r.json().get('description') if json_body else r.reason_phrase}")
    return send

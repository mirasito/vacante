"""Telegram Bot API: адреса методов и разбор ответа, общие для всех модулей, которые пишут в Telegram.

Токен бота входит в адрес запроса, поэтому ни адрес, ни текст сетевой ошибки httpx (в нём тоже адрес)
в логи не попадают: в ошибках только ответ Telegram или вид ошибки."""

from __future__ import annotations

import httpx

API = "https://api.telegram.org"


def url(token: str, method: str) -> str:
    return f"{API}/bot{token}/{method}"


def file_url(token: str, path: str) -> str:
    return f"{API}/file/bot{token}/{path}"


def check(r: httpx.Response) -> None:
    """Ответ не 200 — RuntimeError с кодом и описанием от Telegram."""
    if r.status_code != 200:
        json_body = r.headers.get("content-type", "").startswith("application/json")
        raise RuntimeError(f"Telegram {r.status_code}: {r.json().get('description') if json_body else r.reason_phrase}")


def error_text(exc: BaseException) -> str:
    """Для лога: ответ Telegram (RuntimeError из check) как есть, у остальных ошибок только их вид."""
    return str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__

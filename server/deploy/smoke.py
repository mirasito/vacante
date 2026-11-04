"""Проверяет после выкладки вход из приложения так, как в него входит Mini App на vacante.kz.

Подписывает данные входа (initData) токеном бота, как это делает Telegram, для пользователя, которого
в Telegram быть не может (id 2^53 − 1, а у настоящих не больше 52 бит), и спрашивает GET /me с
заголовком Origin сайта. Сервер должен принять подпись и разрешить ответ сайту (CORS). Для
пользователя без профиля /me ничего не записывает. Данные входа в журнал не попадают.

Запуск: python smoke.py https://api.vacante.kz (токен бота в TELEGRAM_BOT_TOKEN). Тесты сервера
(server/test/smoke.test.ts) запускают проверку против тестового сервера, а с --init-data берут
данные входа и сверяют подпись с той, что проверяет сервер.
"""

import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import NoReturn

TEST_USER = {"id": 2**53 - 1, "first_name": "Vacante deploy check", "language_code": "ru"}
SITE = "https://vacante.kz"


def fail(message: str) -> NoReturn:
    print(f"::error::Вход из приложения не работает: {message}")
    sys.exit(1)


def init_data(token: str, now: int) -> str:
    """Данные входа, подписанные по правилам Telegram для Mini App."""
    fields = {
        "auth_date": str(now),
        "query_id": "vacante-deploy-check",
        "user": json.dumps(TEST_USER, separators=(",", ":")),
    }
    check = "\n".join(f"{key}={value}" for key, value in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urllib.parse.urlencode(fields)


def call(url: str, method: str, headers: dict[str, str]) -> tuple[int, dict[str, str], bytes]:
    request = urllib.request.Request(url, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()
    except OSError as e:
        fail(f"{method} {url}: {e}")


def check(api: str, token: str) -> None:
    status, headers, _ = call(f"{api}/me", "OPTIONS", {
        "Origin": SITE,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
    })
    if status != 204 or headers.get("access-control-allow-origin") != SITE:
        fail(f"сервер не разрешает сайту {SITE} обращаться к {api} (CORS, ответ {status})")
    if "authorization" not in headers.get("access-control-allow-headers", "").lower():
        fail("сервер не разрешает сайту заголовок Authorization (CORS)")

    status, headers, body = call(f"{api}/me", "GET", {
        "Origin": SITE,
        "Authorization": f"tma {init_data(token, int(time.time()))}",
    })
    if status == 401:
        fail("сервер не принял подпись Telegram: токен бота на сервере не тот, что в секрете TELEGRAM_BOT_TOKEN")
    if status != 200:
        fail(f"GET /me ответил {status}")
    if headers.get("access-control-allow-origin") != SITE:
        fail(f"сервер не разрешает сайту {SITE} читать ответ (CORS)")
    try:
        data = json.loads(body)
    except ValueError:
        fail("GET /me ответил не JSON")
    if not isinstance(data, dict) or not isinstance(data.get("user"), dict) or data["user"].get("id") != TEST_USER["id"]:
        fail("GET /me вернул не того пользователя")
    if data.get("profile") is not False:
        fail("у проверочного пользователя оказался профиль")
    print(f"Вход из приложения работает: {api} принимает подпись Telegram и отвечает сайту {SITE}")


def main() -> None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if not token:
        fail("нет секрета TELEGRAM_BOT_TOKEN")
    if sys.argv[1:] == ["--init-data"]:
        print(init_data(token, int(time.time())))
    elif len(sys.argv) == 2 and sys.argv[1].startswith(("https://", "http://127.0.0.1:")):
        # http только для теста сервера на этой же машине
        check(sys.argv[1].rstrip("/"), token)
    else:
        sys.exit("Запуск: python smoke.py https://api.vacante.kz или python smoke.py --init-data")


if __name__ == "__main__":
    main()

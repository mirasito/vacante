"""Общий разбор ответов Telegram Bot API (vacante.tg) и отправители, которые на нём построены."""

import json

import httpx
import pytest

from vacante import autopost, digest, draft, tg


def client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_urls_carry_token_and_method():
    assert tg.url("1:abc", "sendMessage") == "https://api.telegram.org/bot1:abc/sendMessage"
    assert tg.file_url("1:abc", "photos/x.jpg") == "https://api.telegram.org/file/bot1:abc/photos/x.jpg"


def test_check_keeps_token_out_of_the_error():
    tg.check(httpx.Response(200, json={"ok": True}))
    with pytest.raises(RuntimeError) as err:
        tg.check(httpx.Response(400, json={"ok": False, "description": "Bad Request: chat not found"}))
    assert str(err.value) == "Telegram 400: Bad Request: chat not found"
    with pytest.raises(RuntimeError) as err:
        tg.check(httpx.Response(502, text="bad gateway"))
    assert str(err.value) == "Telegram 502: Bad Gateway"


def test_error_text_hides_network_errors():
    # В тексте сетевой ошибки httpx адрес запроса, а в нём токен: в лог только вид ошибки
    assert tg.error_text(RuntimeError("Telegram 400: chat not found")) == "Telegram 400: chat not found"
    assert tg.error_text(httpx.ConnectError("https://api.telegram.org/bot1:secret/sendMessage")) == "ConnectError"


def test_digest_sender_reports_blocked_and_errors():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append((request.url.path, body["chat_id"]))
        status = {1: 200, 2: 403, 3: 500}[body["chat_id"]]
        return httpx.Response(status, json={"ok": status == 200, "description": "Internal"})

    send = digest.telegram_sender(client(handler), "1:abc")
    send(1, "текст", [])
    with pytest.raises(digest.Blocked):
        send(2, "текст", [])
    with pytest.raises(RuntimeError, match="^Telegram 500: Internal$"):
        send(3, "текст", [])
    assert seen[0] == ("/bot1:abc/sendMessage", 1)


def test_autopost_senders_return_message_id():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 42}})

    c = client(handler)
    post = autopost.Post("подпись", b"png", [("Подробнее", "https://vacante.kz/v/1")])
    assert autopost.telegram_sender(c, "1:abc")("@ch", post) == 42
    assert autopost.telegram_button_sender(c, "1:abc")("@ch", "текст", [("a", "https://a")]) == 42
    autopost.telegram_text_sender(c, "1:abc")("@ch", "текст")
    autopost.telegram_pinner(c, "1:abc")("@ch", 42, True)
    autopost.telegram_pinner(c, "1:abc")("@ch", 42, False)
    assert calls == ["/bot1:abc/sendPhoto", "/bot1:abc/sendMessage", "/bot1:abc/sendMessage",
                     "/bot1:abc/pinChatMessage", "/bot1:abc/unpinChatMessage"]


def test_draft_send_counts_failed_chats():
    def handler(request: httpx.Request) -> httpx.Response:
        if json.loads(request.content)["chat_id"] == 2:
            return httpx.Response(403, json={"ok": False, "description": "Forbidden: bot was blocked by the user"})
        return httpx.Response(200, json={"ok": True})

    assert draft.send(client(handler), "1:abc", [1, 2], None) == {"sent": 1, "failed": 1}


def test_cli_helpers(monkeypatch, capsys):
    from vacante import __main__ as cli

    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acc")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "tok")
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    assert cli._secrets(cli.D1_SECRETS) == {"CLOUDFLARE_ACCOUNT_ID": "acc", "CLOUDFLARE_API_TOKEN": "tok"}
    assert cli._secrets(cli.BOT_SECRETS) is None

    cli._annotation("notice", "Итог", "100% готово\r\nвторая строка")
    assert capsys.readouterr().out == "::notice title=Итог::100%25 готово%0Aвторая строка\n"

    class FakeD1:
        def __init__(self, deployed):
            self.deployed = deployed

        def database_id(self):
            return "id" if self.deployed else None

        def query(self, sql):
            assert sql == "SELECT chat_id FROM admins"
            return [{"chat_id": "7"}, {"chat_id": 8}]

    assert cli._moderator_chats(FakeD1(True)) == [7, 8]
    assert cli._moderator_chats(FakeD1(False)) == []

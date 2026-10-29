import json
from datetime import datetime, timedelta, timezone

from vacante import autopost, channels
from vacante.models import RawPost
from vacante.parse import parse_post
from vacante.store import save_vacancies

NOON = datetime(2026, 10, 29, 7, tzinfo=timezone.utc)  # 12:00 в Казахстане
CONF = {"astana": {"chat": "@vacanteastana", "always": True},
        "shymkent": {"chat": "@vacanteshymkent", "always": False},
        "aktau": {"chat": "@vacanteaktau", "always": False}}


def test_config_lists_all_main_cities():
    assert channels.ALL["astana"] == {"chat": "@vacanteastana", "always": True}
    assert channels.ALL["shymkent"] == {"chat": "@vacanteshymkent", "always": False}
    assert len(channels.ALL) == 16


def test_new_channel_turns_on_when_bot_is_admin(tmp_path):
    asked = []

    def check(chat):
        asked.append(chat)
        return chat == "@vacanteshymkent"

    assert channels.refresh(tmp_path, check, NOON, CONF) == {"astana": "@vacanteastana", "shymkent": "@vacanteshymkent"}
    assert asked == ["@vacanteshymkent", "@vacanteaktau"]  # Астану не проверяем
    state = json.loads((tmp_path / "channels.json").read_text("utf-8"))
    assert state["@vacanteaktau"]["live"] is False
    # Через полчаса никого не спрашиваем, через час — только ещё не заработавший
    asked.clear()
    channels.refresh(tmp_path, check, NOON + timedelta(minutes=30), CONF)
    assert asked == []
    channels.refresh(tmp_path, check, NOON + timedelta(hours=1), CONF)
    assert asked == ["@vacanteaktau"]
    # Если Telegram не ответил, оставляем как было
    assert channels.refresh(tmp_path, lambda chat: None, NOON + timedelta(days=2), CONF)["shymkent"]


def test_posts_and_review_queue_only_for_live_channels(tmp_path):
    def make(post_id, city):
        return parse_post(RawPost("telegram", "chan", post_id, f"https://t.me/chan/{post_id}",
                                  "Кафе «Луна» ищет официанта, 300 000 тг", NOON - timedelta(hours=2), city))

    vacancies = [make(1, "shymkent"), make(2, "aktau")]
    save_vacancies(tmp_path, vacancies)
    sent = []
    autopost.run(tmp_path, "https://vacante.kz", lambda chat, post: sent.append(chat), now=NOON,
                 live={"shymkent": "@vacanteshymkent"})
    assert sent == ["@vacanteshymkent"]
    assert [v.city for v in autopost.review_queue(vacancies, {}, {}, NOON, cities=["aktau"])] == ["aktau"]
    assert autopost.review_queue(vacancies, {}, {}, NOON) == []  # по умолчанию только Астана и Алматы


def test_telegram_checker_reads_admin_rights():
    import httpx

    def handler(request):
        chat = dict(httpx.QueryParams(request.content.decode()))["chat_id"]
        if chat == "@none":
            return httpx.Response(400, json={"ok": False, "description": "Bad Request: chat not found"})
        rights = {"@admin": {"status": "administrator", "can_post_messages": True},
                  "@readonly": {"status": "administrator", "can_post_messages": False}}
        return httpx.Response(200, json={"ok": True, "result": rights.get(chat, {"status": "left"})})

    check = channels.telegram_checker(httpx.Client(transport=httpx.MockTransport(handler)), "123:abc")
    assert [check(c) for c in ("@admin", "@readonly", "@left", "@none")] == [True, False, False, False]

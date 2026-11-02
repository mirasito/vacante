import json
from datetime import datetime, timezone

import httpx
from PIL import Image

from vacante import autopost, instagram, venues
from vacante.models import RawPost
from vacante.parse import parse_post
from vacante.store import save_vacancies

NOON = datetime(2026, 11, 2, 7, 30, tzinfo=timezone.utc)  # 12:30 в Казахстане
CONFIG = {"daily_limit": 3, "hours": {"astana": [12], "almaty": [12, 13], "shymkent": [12]},
          "priority": ["astana", "almaty", "shymkent"]}
LIVE = {"astana": "@vacanteastana", "almaty": "@vacantealmaty", "shymkent": "@vacanteshymkent"}


def make(post_id: int, text: str, city: str = "almaty"):
    raw = RawPost("telegram", "chan", post_id, f"https://t.me/chan/{post_id}", text,
                  datetime(2026, 11, 2, 5, tzinfo=timezone.utc), city)
    return parse_post(raw)


def test_due_cities_follow_schedule_live_channels_slot_and_daily_limit():
    assert instagram.due_cities(CONFIG, {}, NOON, LIVE) == ["astana", "almaty", "shymkent"]
    assert instagram.due_cities(CONFIG, {}, NOON, {"almaty": "@vacantealmaty"}) == ["almaty"]
    done = {"astana": {"slot": instagram.slot(NOON)}}
    assert instagram.due_cities(CONFIG, done, NOON, LIVE) == ["almaty", "shymkent"]
    full = {"log": [{"at": NOON.isoformat()}] * 2}
    assert instagram.due_cities(CONFIG, full, NOON, LIVE) == ["astana"]
    later = NOON.replace(hour=8)  # 13:30
    assert instagram.due_cities(CONFIG, {}, later, LIVE) == ["almaty"]


def test_load_config_from_repo():
    config = instagram.load_config()
    assert config["hours"]["astana"][0] == 9 and config["priority"][:2] == ["astana", "almaty"]
    assert 0 < config["daily_limit"] <= 50
    # Сутки при всех городах укладываются в лимит
    assert sum(len(h) for h in config["hours"].values()) <= config["daily_limit"]


def test_pick_takes_posted_to_telegram_newest_first_one_per_employer():
    a = make(1, "Кафе «Зерно» ищет бариста, 12 000 тг за смену")
    b = make(2, "Кафе «Зерно» ищет официанта, 10 000 тг за смену")
    c = make(3, "Ресторан «Сад» ищет повара, 400 000 тг")
    d = make(4, "Требуется грузчик на склад, 300 000 тг")
    old = make(5, "Магазин «Ромашка» ищет продавца, 250 000 тг")
    old.posted_at = "2026-10-20T05:00:00+00:00"
    vacancies = {v.id: v for v in (a, b, c, d, old)}
    posted = {"almaty": {"ids": [old.id, a.id, c.id, b.id, d.id]}}
    picked = instagram.pick("almaty", vacancies, posted, {}, NOON)
    assert [v.id for v in picked] == [d.id, b.id, c.id]
    assert [v.id for v in instagram.pick("almaty", vacancies, posted, {"almaty": {"ids": [d.id, b.id]}}, NOON)] \
        == [c.id, a.id]


def test_caption_lists_vacancies_with_channel_and_hashtags():
    v = make(1, "Кафе «Зерно» ищет бариста, 12 000 тг за смену")
    text = instagram.caption("astana", [v], NOON, "@vacanteastana")
    assert text.startswith("Работа в Астане — свежие вакансии на 2 ноября")
    assert "1. Бариста — " in text and "12\xa0000 ₸/день" in text
    assert "@vacanteastana" in text and "#вакансииастана" in text and "#общепит" in text
    long = [make(i, f"Кафе «{'Очень длинное название ' * 8}{i}» ищет бариста, 12 000 тг") for i in range(9)]
    assert len(instagram.caption("almaty", long, NOON, None)) <= instagram.CAPTION_LIMIT


def write_data(tmp_path, vacancies, posted):
    save_vacancies(tmp_path, vacancies)
    autopost.save_posted(tmp_path, posted)


def test_plan_renders_carousel_and_plan_json(tmp_path, monkeypatch):
    data, out = tmp_path / "data", tmp_path / "public"
    data.mkdir()
    items = [make(i, f"Кафе «Место {i}» ищет бариста, 2/2, 12 000 тг за смену, питание", city="astana")
             for i in range(3)]
    write_data(data, items, {"astana": {"ids": [v.id for v in items]}})
    monkeypatch.setattr(instagram.channels, "live", lambda d: LIVE)
    posts = instagram.plan(data, out, "https://vacante.kz/", NOON, CONFIG)
    assert [p["city"] for p in posts] == ["astana"]  # в Алматы и Шымкенте нет вакансий
    p = posts[0]
    assert len(p["images"]) == 4 and p["images"][0].startswith("https://vacante.kz/ig/astana-2026110212-")
    for url in p["images"]:
        with Image.open(out / url.removeprefix("https://vacante.kz/")) as img:
            assert img.format == "JPEG" and img.size == (1080, 1350)
    assert json.loads((out / instagram.PLAN).read_text("utf-8"))["posts"] == posts


def graph(scopes=("instagram_basic", "instagram_content_publish"), fail_city_image=None, quota=0):
    calls = []

    def handler(request):
        path = request.url.path
        body = dict(httpx.QueryParams(request.content.decode())) if request.method == "POST" else {}
        calls.append((request.method, path.rsplit("/", 1)[-1], body))
        if path.endswith("/me"):
            return httpx.Response(200, json={"id": "99", "instagram_business_account": {"id": "1784"}})
        if path.endswith("/debug_token"):
            return httpx.Response(200, json={"data": {"type": "USER", "scopes": list(scopes)}})
        if path.endswith("/content_publishing_limit"):
            return httpx.Response(200, json={"data": [{"quota_usage": quota, "config": {"quota_total": 50}}]})
        if path.endswith("/1784/media"):
            if fail_city_image and body.get("image_url", "").startswith(fail_city_image):
                return httpx.Response(400, json={"error": {"message": "Only photo or video", "code": 9004}})
            n = sum(1 for c in calls if c[1] == "media")
            return httpx.Response(200, json={"id": f"c{n}"})
        if path.endswith("/media_publish"):
            return httpx.Response(200, json={"id": "post-" + body["creation_id"]})
        return httpx.Response(200, json={"status_code": "FINISHED"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    return instagram.Publisher(venues.InstagramAPI(client, "token"), sleep=lambda s: None), calls


POSTS = [{"city": "astana", "slot": "2026-11-02T12", "ids": ["a", "b"], "caption": "Работа в Астане",
          "images": ["https://vacante.kz/ig/astana/1.jpg", "https://vacante.kz/ig/astana/2.jpg"]},
         {"city": "almaty", "slot": "2026-11-02T12", "ids": ["c", "d"], "caption": "Работа в Алматы",
          "images": ["https://vacante.kz/ig/almaty/1.jpg", "https://vacante.kz/ig/almaty/2.jpg"]}]


def test_publish_carousel_and_remember(tmp_path):
    publisher, calls = graph()
    report = instagram.publish(tmp_path, POSTS, publisher, NOON, CONFIG)
    assert report == [("astana", "опубликовано, 2 вакансий (пост post-c3)"),
                      ("almaty", "опубликовано, 2 вакансий (пост post-c6)")]
    carousel = [b for m, name, b in calls if name == "media" and b.get("media_type") == "CAROUSEL"][0]
    assert carousel["children"] == "c1,c2" and carousel["caption"] == "Работа в Астане"
    children = [b for m, name, b in calls if name == "media" and "image_url" in b]
    assert all(b["is_carousel_item"] == "true" for b in children)
    state = instagram.load_state(tmp_path)
    assert state["astana"]["ids"] == ["a", "b"] and state["astana"]["slot"] == "2026-11-02T12"
    assert len(state["log"]) == 2
    # Повторный запуск того же плана ничего не публикует
    assert instagram.publish(tmp_path, POSTS, graph()[0], NOON, CONFIG)[0] == ("astana", "уже опубликовано в этот час")


def test_publish_skips_without_permission_quota_or_on_error(tmp_path):
    report = instagram.publish(tmp_path, POSTS, graph(scopes=("instagram_basic",))[0], NOON, CONFIG)
    assert report[0][1].startswith("пропущено: у токена нет права instagram_content_publish")
    assert not (tmp_path / instagram.STATE).exists()

    report = instagram.publish(tmp_path, POSTS, graph(quota=49)[0], NOON, CONFIG)
    assert report[1] == ("almaty", "пропущено: дневной лимит публикаций")

    report = instagram.publish(tmp_path / "x", POSTS, graph(fail_city_image="https://vacante.kz/ig/astana")[0],
                               NOON, CONFIG) if (tmp_path / "x").mkdir() is None else None
    assert report[0] == ("astana", "error: Instagram API 400: Only photo or video (code 9004, subcode None)")
    assert report[1][1].startswith("опубликовано")


def test_publish_without_linked_instagram(tmp_path):
    def handler(request):
        if request.url.path.endswith("/me/accounts"):
            return httpx.Response(200, json={"data": []})
        if request.url.path.endswith("/debug_token"):
            return httpx.Response(200, json={"data": {"type": "USER", "scopes": [], "granular_scopes": []}})
        return httpx.Response(400, json={"error": {"message": "nonexisting field", "code": 100}})

    api = venues.InstagramAPI(httpx.Client(transport=httpx.MockTransport(handler)), "token")
    report = instagram.publish(tmp_path, POSTS, instagram.Publisher(api), NOON, CONFIG)
    assert report == [("instagram", "пропущено: Instagram API: у токена нет страницы с привязанным "
                                    "бизнес-аккаунтом Instagram")]
    assert instagram.publish(tmp_path, [], instagram.Publisher(api), NOON, CONFIG) == [("подборки", "на этот час нет")]

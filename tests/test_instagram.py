import json
from datetime import datetime, timedelta, timezone

import httpx
from PIL import Image

from vacante import instagram, venues
from vacante.models import RawPost
from vacante.parse import parse_post
from vacante.store import save_vacancies

NOON = datetime(2026, 11, 18, 5, 30, tzinfo=timezone.utc)  # среда, 10:30 в Казахстане
CONFIG = instagram.load_config()
CONFIG["daily_limit"] = 3


def make(post_id: int, text: str, city: str = "almaty", hours_ago: float = 2, top: bool = False):
    raw = RawPost("telegram", "chan", post_id, f"https://t.me/chan/{post_id}", text,
                  NOON - timedelta(hours=hours_ago), city)
    v = parse_post(raw)
    if top:
        v.top_until = (NOON + timedelta(days=10)).isoformat()
    return v


def test_load_config_from_repo():
    config = instagram.load_config()
    assert config["review"]["hour"] == 10 and config["tips"]["weekdays"] == [1, 3, 5]
    assert 9 in config["pro"]["hours"] and config["pro"]["repost_days"] == 7
    assert 0 < config["daily_limit"] <= 50


def test_daily_due_once_a_day_from_its_hour_until_21(tmp_path):
    assert instagram.daily_due("review", CONFIG, {}, NOON)
    assert not instagram.daily_due("review", CONFIG, {"done": {"review": "2026-11-18"}}, NOON)
    assert not instagram.daily_due("review", CONFIG, {}, NOON - timedelta(hours=1))  # 9:30
    assert instagram.daily_due("review", CONFIG, {}, NOON + timedelta(hours=5))  # 15:30: догоняем
    assert not instagram.daily_due("employers", CONFIG, {}, NOON + timedelta(hours=3))  # среда — не его день
    assert instagram.daily_due("tips", CONFIG, {}, NOON + timedelta(days=1, hours=5))  # четверг


def test_only_pro_vacancies_new_first_and_again_after_a_week():
    plain = make(1, "Кафе «Зерно» ищет бариста, 12 000 тг за смену")
    pro = make(2, "Ресторан «Сад» ищет повара, 400 000 тг", top=True)
    old = make(3, "Склад ищет грузчика, 300 000 тг", top=True, hours_ago=200)
    expired = make(4, "Магазин ищет продавца, 250 000 тг")
    expired.top_until = (NOON - timedelta(days=1)).isoformat()
    items, fresh = instagram.pro_due([plain, pro, old, expired], {}, NOON)
    assert [v.id for v in items] == [pro.id, old.id] and fresh == {pro.id, old.id}
    week_ago = (NOON - timedelta(days=8)).isoformat()
    state = {"pro": {pro.id: [NOON.isoformat()], old.id: [week_ago]}}
    items, fresh = instagram.pro_due([plain, pro, old], state, NOON)
    assert [v.id for v in items] == [old.id] and fresh == set()
    state["pro"][old.id].append(NOON.isoformat())  # дважды уже было
    assert instagram.pro_due([plain, pro, old], state, NOON) == ([], set())


def test_market_counts_last_day_and_pay_by_profession():
    items = [make(i, f"Кафе «Место {i}» ищет официанта, {200 + i * 10} 000 тг") for i in range(12)]
    items += [make(50, "Склад ищет грузчика, 300 000 тг", city="astana"),
              make(51, "Склад ищет грузчика", city="astana", hours_ago=30)]
    m = instagram.market(items, NOON)
    assert m["new"] == 13 and m["total"] == 14
    assert m["cities"] == [("almaty", 12), ("astana", 1)]
    assert m["pays"][0][0] == "Официант" and 250_000 <= m["pays"][0][1] <= 270_000
    assert instagram._change(13, {"date": "2026-11-17", "new": 10}, NOON) == ("+30% к вчера", "кешемен салыстырғанда +30%")
    assert instagram._change(13, {"date": "2026-11-10", "new": 10}, NOON) is None


def check_images(out, urls, size=(1080, 1350)):
    for url in urls:
        with Image.open(out / url.removeprefix("https://vacante.kz/")) as img:
            assert img.format == "JPEG" and img.size == size


def test_plan_review_pro_and_stories(tmp_path):
    data, out = tmp_path / "data", tmp_path / "public"
    data.mkdir()
    items = [make(i, f"Кафе «Место {i}» ищет бариста, 2/2, 12 000 тг за смену, питание") for i in range(3)]
    items += [make(10, "Ресторан «Сад» ищет повара, 400 000 тг", top=True, city="astana"),
              make(11, "Пекарня «Хлеб» ищет пекаря, 350 000 тг", top=True)]
    save_vacancies(data, items)
    config = {**CONFIG, "daily_limit": 10}
    posts = instagram.plan(data, out, "https://vacante.kz/", NOON, config, reel=lambda *a: None)
    assert [p["kind"] for p in posts] == ["review", "pro", "story", "story"]
    review, pro = posts[0], posts[1]
    assert review["type"] == "carousel" and review["new"] == 5 and review["caption"].startswith("Рынок работы на 18 ноября")
    assert pro["type"] == "carousel" and len(pro["images"]) == 3 and set(pro["ids"]) == {items[3].id, items[4].id}
    assert "Бариста" not in pro["caption"]  # вакансии без «Про» в Instagram не идут
    check_images(out, review["images"] + pro["images"])
    check_images(out, posts[2]["images"], (1080, 1920))
    assert json.loads((out / instagram.PLAN).read_text("utf-8"))["posts"] == posts
    # Одна Про-вакансия — одна картинка, без обложки; лимит в сутки соблюдаем
    save_vacancies(data, items[:4])
    posts = instagram.plan(data, out, "https://vacante.kz", NOON, {**CONFIG, "daily_limit": 2}, reel=lambda *a: None)
    assert [(p["kind"], p["type"]) for p in posts] == [("review", "carousel"), ("pro", "image")]


def test_tips_and_employers_cards():
    image, text = instagram.tip_card(len(instagram.TIPS) + 1)
    assert text.startswith(instagram.TIPS[1][0]) and image[:2] == b"\xff\xd8"
    image, text = instagram.employers_card()
    assert "990 ₸" in text and "Instagram" in text


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


POSTS = [{"kind": "review", "type": "carousel", "slot": "2026-11-18T10", "new": 120, "caption": "Рынок работы",
          "images": ["https://vacante.kz/ig/1/review-1.jpg", "https://vacante.kz/ig/1/review-2.jpg"]},
         {"kind": "pro", "type": "image", "slot": "2026-11-18T10", "ids": ["a"], "caption": "Про",
          "images": ["https://vacante.kz/ig/1/pro-1.jpg"]},
         {"kind": "story", "type": "story", "slot": "2026-11-18T10", "ids": ["a"],
          "images": ["https://vacante.kz/ig/1/story-1.jpg"]}]


def test_publish_each_kind_and_remember(tmp_path):
    publisher, calls = graph()
    report = instagram.publish(tmp_path, POSTS, publisher, NOON, {**CONFIG, "daily_limit": 10})
    assert [r[1].split(" (")[0] for r in report] == ["опубликовано"] * 3
    carousel = [b for m, name, b in calls if name == "media" and b.get("media_type") == "CAROUSEL"][0]
    assert carousel["children"] == "c1,c2" and carousel["caption"] == "Рынок работы"
    story = [b for m, name, b in calls if name == "media" and b.get("media_type") == "STORIES"][0]
    assert story["image_url"].endswith("story-1.jpg") and "caption" not in story
    single = [b for m, name, b in calls if name == "media" and b.get("image_url", "").endswith("pro-1.jpg")][0]
    assert single["caption"] == "Про" and "is_carousel_item" not in single
    state = instagram.load_state(tmp_path)
    assert state["done"]["review"] == "2026-11-18" and state["review"] == {"date": "2026-11-18", "new": 120}
    assert state["pro"]["a"] == [NOON.isoformat()] and state["pro_slot"] == "2026-11-18T10" and len(state["log"]) == 3
    # Повторный запуск того же плана ничего не публикует
    again = instagram.publish(tmp_path, POSTS[:2], graph()[0], NOON, CONFIG)
    assert again == [("review", "уже опубликовано"), ("pro", "уже опубликовано")]


def test_publish_reel_waits_for_video(tmp_path):
    publisher, calls = graph()
    post = {"kind": "reel", "type": "reel", "slot": "x", "video": "https://vacante.kz/ig/1/reel.mp4", "caption": "Ролик"}
    assert instagram.publish(tmp_path, [post], publisher, NOON, CONFIG)[0][1].startswith("опубликовано")
    reel = [b for m, name, b in calls if name == "media"][0]
    assert reel["media_type"] == "REELS" and reel["video_url"].endswith("reel.mp4") and reel["share_to_feed"] == "true"


def test_publish_skips_without_permission_quota_or_on_error(tmp_path):
    report = instagram.publish(tmp_path, POSTS, graph(scopes=("instagram_basic",))[0], NOON, CONFIG)
    assert report[0][1].startswith("error: у токена нет права instagram_content_publish")
    assert not (tmp_path / instagram.STATE).exists()

    report = instagram.publish(tmp_path, POSTS, graph(quota=49)[0], NOON, CONFIG)
    assert report[1] == ("pro", "пропущено: дневной лимит публикаций")

    (tmp_path / "x").mkdir()
    report = instagram.publish(tmp_path / "x", POSTS, graph(fail_city_image="https://vacante.kz/ig/1/review")[0],
                               NOON, CONFIG)
    assert report[0] == ("review", "error: Instagram API 400: Only photo or video (code 9004, subcode None)")
    assert report[1][1].startswith("опубликовано")


class FakeD1:
    def __init__(self):
        self.row = None

    def query(self, sql, params=None):
        if sql.startswith("SELECT"):
            return [self.row] if self.row else []
        if sql.startswith("INSERT"):
            self.row = dict(zip(("token", "seed", "refreshed_at"), params))
        return []


def test_token_store_refreshes_weekly_and_takes_new_secret():
    d1, store = FakeD1(), None
    store = instagram.TokenStore(d1)
    refreshed = []
    refresh = lambda t: refreshed.append(t) or f"{t}+"  # noqa: E731
    assert store.token("IGA1", refresh, NOON) == "IGA1+"
    assert store.token("IGA1", refresh, NOON + timedelta(days=3)) == "IGA1+" and refreshed == ["IGA1"]
    assert store.token("IGA1", refresh, NOON + timedelta(days=8)) == "IGA1++"
    assert store.token("IGB2", refresh, NOON + timedelta(days=9)) == "IGB2+"  # новый секрет
    assert store.token("IGB2", lambda t: None, NOON + timedelta(days=30)) == "IGB2+"  # не продлился — старый
    assert store.token("EAAfb", refresh, NOON) == "EAAfb"


def test_publish_without_linked_instagram(tmp_path):
    def handler(request):
        if request.url.path.endswith("/me/accounts"):
            return httpx.Response(200, json={"data": []})
        if request.url.path.endswith("/debug_token"):
            return httpx.Response(200, json={"data": {"type": "USER", "scopes": [], "granular_scopes": []}})
        return httpx.Response(400, json={"error": {"message": "nonexisting field", "code": 100}})

    api = venues.InstagramAPI(httpx.Client(transport=httpx.MockTransport(handler)), "token")
    report = instagram.publish(tmp_path, POSTS, instagram.Publisher(api), NOON, CONFIG)
    assert report == [("instagram", "error: Instagram API: у токена нет страницы с привязанным "
                                    "бизнес-аккаунтом Instagram")]
    assert instagram.publish(tmp_path, [], instagram.Publisher(api), NOON, CONFIG) == [("instagram", "на этот час ничего нет")]


def test_publish_with_instagram_login_token_needs_no_facebook_page(tmp_path):
    hosts, calls = set(), []

    def handler(request):
        hosts.add(request.url.host)
        path = request.url.path
        calls.append(path.rsplit("/", 1)[-1])
        if path.endswith("/me"):
            return httpx.Response(200, json={"user_id": 1784, "username": "vacante.kz"})
        if path.endswith("/content_publishing_limit"):
            return httpx.Response(200, json={"data": [{"quota_usage": 0, "config": {"quota_total": 100}}]})
        if path.endswith("/1784/media"):
            return httpx.Response(200, json={"id": f"c{calls.count('media')}"})
        if path.endswith("/media_publish"):
            return httpx.Response(200, json={"id": "post"})
        return httpx.Response(200, json={"status_code": "FINISHED"})

    api = venues.InstagramAPI(httpx.Client(transport=httpx.MockTransport(handler)), "IGAAtoken")
    assert api.check() == [("токен", "вход через Instagram, @vacante.kz, id 1784: подборки в ленту работают, "
                                     "аватары заведений через такой токен недоступны")]
    report = instagram.publish(tmp_path, POSTS[:1], instagram.Publisher(api, sleep=lambda s: None), NOON, CONFIG)
    assert report == [("review", "опубликовано (пост post)")]
    assert hosts == {"graph.instagram.com"} and "debug_token" not in calls

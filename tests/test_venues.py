import json
from datetime import datetime, timedelta, timezone
from io import BytesIO

import httpx
import pytest
from PIL import Image

from vacante import autopost, card, venues
from vacante.models import RawPost
from vacante.parse import parse_post
from vacante.site.build import build
from vacante.store import save_vacancies

NOW = datetime(2026, 10, 28, 7, tzinfo=timezone.utc)  # 12:00 в Казахстане
DINO = "💼 Бармен\nDINO FEST\n💰 18 000 ₸ / смена\n📍 Алматы\n\nСемейному рестопарку требуются два бармена."


def make(post_id: int, text: str, city: str = "almaty", hours_ago: int = 1):
    return parse_post(RawPost("telegram", "chan", post_id, f"https://t.me/chan/{post_id}", text,
                              NOW - timedelta(hours=hours_ago), city))


def png(color: str = "orange", size: tuple[int, int] = (500, 400)) -> bytes:
    out = BytesIO()
    Image.new("RGB", size, color).save(out, "PNG")
    return out.getvalue()


def test_key_ignores_case_quotes_and_legal_form():
    assert venues.key("DINO FEST", "almaty") == "almaty:dino fest"
    assert venues.key("ТОО «Алексеевский хлебный дом»", "almaty") == venues.key("Алексеевский  хлебный дом", "almaty")
    assert venues.key("Ёлки", "astana") == "astana:елки"


@pytest.mark.parametrize("value, expected", [
    ("@Dino_fest_almaty", "dino_fest_almaty"),
    ("https://instagram.com/Dino_fest_almaty", "dino_fest_almaty"),
    ("https://www.instagram.com/dino_fest_almaty/?hl=ru", "dino_fest_almaty"),
    ("https://www.instagram.com/p/C1abc/", None),
    ("не нашёл", None),
    (None, None),
])
def test_handle(value, expected):
    assert venues.handle(value) == expected


def test_queue_lists_unknown_venues_freshest_and_busiest_first():
    dino = [make(1, DINO), make(2, DINO.replace("Бармен", "Официант"))]
    small = make(3, "Сеть супермаркетов SMALL приглашает на работу продавца, 205 000 тг", hours_ago=2)
    old = make(4, "Ресторан Ramen77 ищет официанта, 14 000 тг в день", hours_ago=60)
    known = make(5, "Кафе «Зерно» ищет бариста", hours_ago=1)
    nameless = make(6, "Требуется грузчик на склад")
    table = {venues.key("Зерно", "almaty"): {"status": "none"}}
    items = venues.queue([*dino, small, old, known, nameless], table, NOW)
    assert [(i["key"], i["vacancies"]) for i in items] == [
        ("almaty:dino fest", 2), ("almaty:small", 1), ("almaty:ramen77", 1)]
    assert items[0]["city_name"] == "Алматы" and items[0]["text"].startswith("💼 Бармен")


def test_apply_records_findings_and_rejects_bad_input(tmp_path):
    venues.save(tmp_path, {"almaty:small": {"name": "SMALL", "city": "almaty", "status": "none", "avatar": "a.jpg"}})
    report = venues.apply(tmp_path, [
        {"key": "almaty:dino fest", "status": "found", "instagram": "https://instagram.com/Dino_fest_almaty",
         "source": "https://2gis.kz/almaty/firm/70000001110093666"},
        {"key": "almaty:small", "status": "none"},
        {"key": "astana:бизнес центр", "status": "skip"},
        {"key": "almaty:qaimaq", "status": "found", "instagram": "не знаю"},
        {"key": "almaty:x", "status": "maybe"},
        {"status": "none"},
    ], now=NOW)
    assert [outcome.split(":")[0] for _, outcome in report] == [
        "found @dino_fest_almaty", "none", "skip", "error", "error", "error"]
    table = venues.load(tmp_path)
    assert table["almaty:dino fest"]["instagram"] == "dino_fest_almaty"
    assert table["almaty:small"]["avatar"] == "a.jpg"  # аватар, поставленный вручную, остаётся
    assert "almaty:qaimaq" not in table and "almaty:x" not in table


def test_fetch_avatars_saves_square_jpeg_and_waits_before_retry(tmp_path):
    venues.save(tmp_path, {
        "almaty:dino fest": {"name": "DINO FEST", "city": "almaty", "status": "found", "instagram": "dino_fest_almaty"},
        "almaty:pelmen": {"name": "Пельмень", "city": "almaty", "status": "found", "instagram": "pelmen.kz"},
        "almaty:small": {"name": "SMALL", "city": "almaty", "status": "none"},
    })
    calls = []

    def source(username):
        calls.append(username)
        return png() if username == "dino_fest_almaty" else None

    report = dict(venues.fetch_avatars(tmp_path, source, NOW))
    assert report == {"almaty:dino fest": "аватар скачан",
                      "almaty:pelmen": "аватара нет: аккаунт не бизнес, закрыт или не найден"}
    table = venues.load(tmp_path)
    with Image.open(tmp_path / "venues" / table["almaty:dino fest"]["avatar"]) as img:
        assert (img.format, img.size) == ("JPEG", (320, 320))
    # Через день не пробуем снова, через неделю пробуем
    assert venues.fetch_avatars(tmp_path, source, NOW + timedelta(days=1)) == []
    assert [k for k, _ in venues.fetch_avatars(tmp_path, source, NOW + timedelta(days=8))] == ["almaty:pelmen"]
    assert calls == ["dino_fest_almaty", "pelmen.kz", "pelmen.kz"]


def test_bad_token_stops_and_retries_next_time(tmp_path):
    venues.save(tmp_path, {f"almaty:v{i}": {"name": f"V{i}", "status": "found", "instagram": f"v{i}"} for i in range(3)})

    def source(username):
        raise venues.TokenError("Instagram API 400: token expired (code 190, subcode 463)")

    assert len(venues.fetch_avatars(tmp_path, source, NOW)) == 1
    assert len(venues.fetch_avatars(tmp_path, lambda u: png(), NOW)) == 3


def graph(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_instagram_api_with_page_token():
    def handler(request):
        fields = request.url.params.get("fields", "")
        if request.url.path.endswith("/me"):
            return httpx.Response(200, json={"instagram_business_account": {"id": "1784"}, "id": "99"})
        if request.url.path.endswith("/1784") and "username(dino_fest_almaty)" in fields:
            return httpx.Response(200, json={"business_discovery": {"profile_picture_url": "https://cdn.test/a.jpg"}})
        if request.url.path.endswith("/1784"):
            return httpx.Response(400, json={"error": {"message": "Invalid user id", "code": 110,
                                                       "error_subcode": 2207013}})
        assert request.url.host == "cdn.test"
        return httpx.Response(200, content=b"jpeg")

    api = venues.InstagramAPI(graph(handler), "page-token")
    assert api.avatar("dino_fest_almaty") == b"jpeg"
    assert api.avatar("not.business") is None


def test_instagram_api_with_user_token_and_expired_token():
    def handler(request):
        if request.url.path.endswith("/me"):
            return httpx.Response(200, json={"id": "5"})
        if request.url.path.endswith("/me/accounts"):
            return httpx.Response(200, json={"data": [{"id": "1"}, {"id": "2", "instagram_business_account": {"id": "77"}}]})
        return httpx.Response(400, json={"error": {"message": "Session has expired", "code": 190}})

    api = venues.InstagramAPI(graph(handler), "user-token")
    assert api.user_id() == "77"
    with pytest.raises(venues.TokenError):
        api.avatar("dino_fest_almaty")


def test_site_and_post_show_avatar_and_instagram(tmp_path):
    data = tmp_path / "data"
    v = make(1, DINO)
    save_vacancies(data, [v])
    venues.apply(data, [{"key": "almaty:dino fest", "status": "found", "instagram": "dino_fest_almaty"}], now=NOW)
    plain = autopost.make_post(v, "https://vacante.kz")
    venues.set_avatar(data, "DINO FEST", "almaty", png())
    venue = venues.lookup(venues.load(data), v)
    avatar = venues.avatar_bytes(data, venue)

    build(data, tmp_path / "out", now=NOW)
    listing = (tmp_path / "out" / "almaty" / "index.html").read_text("utf-8")
    assert f'src="/venues/{venue["avatar"]}"' in listing
    page = (tmp_path / "out" / "v" / v.id / "index.html").read_text("utf-8")
    assert 'href="https://www.instagram.com/dino_fest_almaty/"' in page and "@dino_fest_almaty" in page
    ld = json.loads(page.split('<script type="application/ld+json">')[1].split("</script>")[0])
    assert ld["hiringOrganization"] == {"@type": "Organization", "name": "DINO FEST",
                                       "logo": f"https://vacante.kz/venues/{venue['avatar']}",
                                       "sameAs": "https://www.instagram.com/dino_fest_almaty/"}
    assert (tmp_path / "out" / "venues" / venue["avatar"]).exists()

    post = autopost.make_post(v, "https://vacante.kz", venue, avatar)
    assert ("📸 Instagram", "https://www.instagram.com/dino_fest_almaty/") in post.buttons
    assert post.photo != plain.photo and post.photo == card.render(v, avatar)
    with Image.open(BytesIO(post.photo)) as img:  # на месте значка аватар, а не буква на цветном фоне
        r, g, b = img.getpixel((100, 100))
        assert abs(r - 255) + abs(g - 165) + b < 10  # оранжевый аватар, сжатый в JPEG


def test_autopost_sends_avatar_and_prefers_venues_with_it(tmp_path):
    dino, other = make(1, DINO), make(2, "Кафе «Зерно» ищет бармена, 2/2, 18 000 тг за смену")
    save_vacancies(tmp_path, [dino, other])
    venues.set_avatar(tmp_path, "DINO FEST", "almaty", png(), instagram="dino_fest_almaty")
    sent = []
    autopost.run(tmp_path, "https://vacante.kz", lambda chat, post: sent.append(post), now=NOW)
    assert ("📸 Instagram", "https://www.instagram.com/dino_fest_almaty/") in sent[0].buttons

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
    skipped = make(6, "Кафе «Луна» ищет бариста", hours_ago=1)
    nameless = make(7, "Требуется грузчик на склад")
    table = {venues.key("Зерно", "almaty"): {"status": "none", "v": venues.VERSION},
             venues.key("Луна", "almaty"): {"status": "skip"},
             venues.key("SMALL", "almaty"): {"status": "none", "v": 2}}  # разобран по старым правилам: ещё раз
    items = venues.queue([*dino, small, old, known, skipped, nameless], table, NOW)
    assert [(i["key"], i["vacancies"]) for i in items] == [
        ("almaty:dino fest", 2), ("almaty:small", 1), ("almaty:ramen77", 1)]
    assert items[0]["city_name"] == "Алматы" and items[0]["text"].startswith("💼 Бармен")
    assert items[0]["twogis"] == "https://2gis.kz/almaty/search/DINO%20FEST"


@pytest.mark.parametrize("name, city, expected", [
    ("МАНГАЛ", "astana", "https://2gis.kz/astana/search/%D0%9C%D0%90%D0%9D%D0%93%D0%90%D0%9B"),
    ("TOO Arlan logistics", "almaty", "https://2gis.kz/almaty/search/Arlan%20logistics"),
    ("KARI", "ust-kamenogorsk", "https://2gis.kz/ustkam/search/KARI"),
    ("KARI", None, None),
])
def test_twogis_search(name, city, expected):
    assert venues.twogis_search(name, city) == expected


@pytest.mark.parametrize("value, expected", [
    ("@DinoFest", "dinofest"), ("https://t.me/dinofest_kz", "dinofest_kz"), ("t.me/joinchat/AAAA", None),
    ("https://t.me/+AbCdEf", None), ("abc", None),
])
def test_telegram_handle(value, expected):
    assert venues.telegram_handle(value) == expected


@pytest.mark.parametrize("value, expected", [
    ("dinofest.kz", "https://dinofest.kz/"), ("http://WWW.Laffa.kz/menu", "http://www.laffa.kz/menu"),
    ("https://taplink.cc/dinofest", "https://taplink.cc/dinofest"), ("https://instagram.com/dinofest", None),
    ("https://wa.me/77010000000", None), ("https://2gis.kz/almaty/firm/1", None), ("localhost", None),
])
def test_website_url(value, expected):
    assert venues.website_url(value) == expected


def test_apply_records_findings_and_rejects_bad_input(tmp_path):
    venues.save(tmp_path, {
        "almaty:small": {"name": "SMALL", "city": "almaty", "status": "none", "avatar": "a.jpg"},
        "almaty:laffa": {"name": "Лаффа", "status": "found", "instagram": "laffa.cafe", "avatar": "b.jpg",
                         "avatar_source": "instagram"},
    })
    report = venues.apply(tmp_path, [
        {"key": "almaty:dino fest", "status": "found", "instagram": "https://instagram.com/Dino_fest_almaty",
         "website": "dinofest.kz", "source": "https://2gis.kz/almaty/firm/70000001110093666"},
        {"key": "almaty:small", "status": "none"},
        {"key": "almaty:laffa", "status": "found", "instagram": "laffa_almaty"},
        {"key": "astana:бизнес центр", "status": "skip"},
        {"key": "almaty:qaimaq", "status": "found", "instagram": "не знаю"},
        {"key": "almaty:pelmen", "status": "found"},
        {"key": "almaty:x", "status": "maybe"},
        {"status": "none"},
    ], now=NOW)
    assert [outcome for _, outcome in report][:4] == [
        "found instagram=dino_fest_almaty website=https://dinofest.kz/", "none", "found instagram=laffa_almaty", "skip"]
    assert all(outcome.startswith("error") for _, outcome in report[4:])
    table = venues.load(tmp_path)
    assert table["almaty:dino fest"]["v"] == venues.VERSION
    assert table["almaty:small"]["avatar"] == "a.jpg"  # аватар, поставленный вручную, остаётся
    assert "avatar" not in table["almaty:laffa"]  # аккаунт сменился: старый аватар был чужой
    assert not {"almaty:qaimaq", "almaty:pelmen", "almaty:x"} & table.keys()


def test_fetch_avatars_tries_sources_in_order_and_waits_before_retry(tmp_path):
    venues.save(tmp_path, {
        "almaty:dino fest": {"name": "DINO FEST", "status": "found", "instagram": "dino_fest_almaty",
                             "website": "https://dinofest.kz/"},
        "almaty:pelmen": {"name": "Пельмень", "status": "found", "telegram": "pelmen_kz"},
        "almaty:small": {"name": "SMALL", "status": "none"},
    })
    calls = []

    def source(field, found):
        def fetch(value):
            calls.append(value)
            return png() if value in found else None
        return fetch

    sources = {"telegram": source("telegram", set()), "website": source("website", {"https://dinofest.kz/"})}
    report = dict(venues.fetch_avatars(tmp_path, sources, NOW))
    assert report == {"almaty:dino fest": "аватар скачан (website)", "almaty:pelmen": "аватара нет: telegram: нет"}
    table = venues.load(tmp_path)
    assert table["almaty:dino fest"]["avatar_source"] == "website"
    with Image.open(tmp_path / "venues" / table["almaty:dino fest"]["avatar"]) as img:
        assert (img.format, img.size) == ("JPEG", (320, 320))
    # Через день не пробуем снова, через неделю пробуем
    assert venues.fetch_avatars(tmp_path, sources, NOW + timedelta(days=1)) == []
    assert [k for k, _ in venues.fetch_avatars(tmp_path, sources, NOW + timedelta(days=8))] == ["almaty:pelmen"]
    assert calls == ["https://dinofest.kz/", "pelmen_kz", "pelmen_kz"]


def test_new_source_is_tried_at_once(tmp_path):
    venues.save(tmp_path, {"almaty:v": {"name": "V", "status": "found", "instagram": "v", "website": "https://v.kz/"}})
    assert venues.fetch_avatars(tmp_path, {"website": lambda u: None}, NOW) == [("almaty:v", "аватара нет: website: нет")]
    # Появился токен Instagram: заведение пробуем сразу, не дожидаясь недели
    report = venues.fetch_avatars(tmp_path, {"instagram": lambda u: png(), "website": lambda u: None},
                                  NOW + timedelta(hours=1))
    assert report == [("almaty:v", "аватар скачан (instagram)")]


def test_bad_token_stops_source_and_retries_next_time(tmp_path):
    venues.save(tmp_path, {f"almaty:v{i}": {"name": f"V{i}", "status": "found", "instagram": f"v{i}"} for i in range(3)})

    def source(username):
        raise venues.TokenError("Instagram API 400: token expired (code 190, subcode 463)")

    report = venues.fetch_avatars(tmp_path, {"instagram": source}, NOW)
    assert report[-1] == ("instagram", "error: Instagram API 400: token expired (code 190, subcode 463)")
    assert len(venues.fetch_avatars(tmp_path, {"instagram": lambda u: png()}, NOW)) == 3


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


def test_telegram_avatar_via_bot_api():
    def handler(request):
        assert "SECRET" in request.url.path
        if request.url.path.endswith("/getChat"):
            if request.url.params["chat_id"] == "@dinofest":
                return httpx.Response(200, json={"ok": True, "result": {"id": -100, "photo": {"big_file_id": "F1"}}})
            return httpx.Response(400, json={"ok": False, "error_code": 400, "description": "Bad Request: chat not found"})
        if request.url.path.endswith("/getFile"):
            return httpx.Response(200, json={"ok": True, "result": {"file_path": "photos/1.jpg"}})
        assert request.url.path == "/file/botSECRET/photos/1.jpg"
        return httpx.Response(200, content=b"jpeg")

    tg = venues.TelegramAvatars(graph(handler), "SECRET")
    assert tg.avatar("dinofest") == b"jpeg"
    assert tg.avatar("someone") is None
    bad = venues.TelegramAvatars(graph(lambda r: httpx.Response(
        401, json={"ok": False, "error_code": 401, "description": "Unauthorized"})), "SECRET")
    with pytest.raises(venues.TokenError) as exc:
        bad.avatar("dinofest")
    assert "SECRET" not in str(exc.value)


def site(pages: dict[str, httpx.Response]):
    return graph(lambda request: pages.get(str(request.url), httpx.Response(404)))


def image(size=(180, 180)) -> httpx.Response:
    return httpx.Response(200, content=png(size=size), headers={"content-type": "image/png"})


def html(body: str) -> httpx.Response:
    return httpx.Response(200, text=f"<html><head>{body}</head></html>", headers={"content-type": "text/html"})


def test_website_logo_prefers_touch_icon_and_respects_robots():
    logo = venues.WebsiteLogo(site({
        "https://dinofest.kz/": html('<meta property="og:image" content="/banner.png">'
                                     '<link rel="icon" sizes="32x32" href="/i32.png">'
                                     '<link rel="apple-touch-icon" sizes="180x180" href="/touch.png">'),
        "https://dinofest.kz/touch.png": image(),
        "https://dinofest.kz/banner.png": image((1200, 630)),
    }))
    assert logo.avatar("https://dinofest.kz/") == png(size=(180, 180))
    # Широкий баннер превью не годится в аватар, мелкая иконка тоже
    wide = venues.WebsiteLogo(site({
        "https://laffa.kz/": html('<meta property="og:image" content="https://cdn.laffa.kz/og.png">'
                                  '<link rel="icon" href="/favicon.png">'),
        "https://cdn.laffa.kz/og.png": image((1200, 630)), "https://laffa.kz/favicon.png": image((32, 32)),
    }))
    assert wide.avatar("https://laffa.kz/") is None
    square_og = venues.WebsiteLogo(site({
        "https://pelmen.kz/": html('<meta property="og:image" content="/og.png">'),
        "https://pelmen.kz/og.png": image((400, 400)),
    }))
    assert square_og.avatar("https://pelmen.kz/") is not None
    closed = venues.WebsiteLogo(site({
        "https://shop.kz/robots.txt": httpx.Response(200, text="User-agent: *\nDisallow: /\n"),
        "https://shop.kz/": html('<link rel="apple-touch-icon" href="/touch.png">'),
        "https://shop.kz/touch.png": image(),
    }))
    assert closed.avatar("https://shop.kz/") is None


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
    venues.apply(data, [{"key": "almaty:dino fest", "status": "found", "instagram": "dino_fest_almaty",
                         "telegram": "dinofest", "website": "https://www.dinofest.kz/"}], now=NOW)
    build(data, tmp_path / "out", now=NOW)
    page = (tmp_path / "out" / "v" / v.id / "index.html").read_text("utf-8")
    assert 'href="https://t.me/dinofest"' in page and ">dinofest.kz</a>" in page
    assert f'src="/venues/{venue["avatar"]}"' in page  # ручной аватар пережил новые ссылки

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

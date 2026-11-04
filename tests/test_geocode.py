import json
import logging
from datetime import datetime, timedelta, timezone

import httpx

from vacante import collect, geocode
from vacante.models import RawPost, Vacancy
from vacante.site import appfeed

NOW = datetime(2026, 11, 4, 12, tzinfo=timezone.utc)
TODAY = NOW.date().isoformat()
HOUSE = (43.2389, 76.9123)  # дом в Алматы


def vacancy(id_, address, city="almaty", source="telegram", posted="2026-11-04T10:00:00+00:00"):
    return Vacancy(id=id_, title="Официант", category="horeca", city=city, salary_min=None, salary_max=None,
                   salary_period=None, schedule=None, perks=[], employer=None, text="Официант", source=source,
                   source_url=f"https://t.me/chan_a/{id_}", posted_at=posted, fingerprint=id_, address=address)


def place(lat, lon, half=0.0005):
    """Ответ Nominatim: точка и её рамка [юг, север, запад, восток]."""
    return [{"lat": str(lat), "lon": str(lon),
             "boundingbox": [str(lat - half), str(lat + half), str(lon - half), str(lon + half)]}]


def nominatim(answers=None, status=200):
    """Клиент с подменённым Nominatim: answers — ответ на строку поиска, по умолчанию «не найдено»."""
    asked = []

    def handle(request):
        asked.append(request)
        q = request.url.params["q"]
        return httpx.Response(status, json=(answers or {}).get(q, []) if status == 200 else {"error": "slow down"})

    return asked, httpx.Client(transport=httpx.MockTransport(handle))


def locate(vacancies, data_dir, client, now=NOW, limit=60):
    return geocode.locate(vacancies, data_dir, now, client=client, sleep=lambda s: None, limit=limit)


def test_query_is_address_and_city():
    assert geocode.query(vacancy("a", "ул. Сыганак, 2")) == "ул. Сыганак, 2, Алматы"
    assert geocode.query(vacancy("a", "г. Алматы, ул. Абая 10")) == "ул. Абая 10, Алматы"
    assert geocode.query(vacancy("a", "Алматы қаласы, Ақсай-5, 25а")) == "Ақсай-5, 25а, Алматы"
    assert geocode.query(vacancy("a", "ТРЦ «Керуен» (2 этаж)", city="astana")) == "ТРЦ «Керуен», Астана"
    assert geocode.query(vacancy("a", "пр. Абая 52, рядом с…")) == "пр. Абая 52, рядом с, Алматы"
    assert geocode.query(vacancy("a", "Алматинская 5")) == "Алматинская 5, Алматы"  # не город, а улица


def test_nothing_to_look_up():
    assert geocode.query(vacancy("a", "Есильский район", city="astana")) is None  # ни дома, ни ТЦ: точки нет
    assert geocode.query(vacancy("a", None)) is None
    assert geocode.query(vacancy("a", "ул. Сыганак, 2", city=None)) is None
    assert geocode.query(vacancy("hh-1", "Абая, 150", source="hh")) is None  # у hh точку ставит сам hh
    placed = vacancy("a", "ул. Сыганак, 2")
    placed.lat, placed.lon = HOUSE
    assert geocode.query(placed) is None


def test_address_is_asked_once_and_then_comes_from_the_cache(tmp_path):
    asked, client = nominatim({"ул. Сыганак, 2, Алматы": place(*HOUSE)})
    first = [vacancy("chan_a-1", "ул. Сыганак, 2"), vacancy("chan_b-7", "Ул. Сыганак, 2")]
    stats = locate(first, tmp_path, client)
    assert len(asked) == 1 and stats == {"addresses": 1, "cached": 0, "asked": 1, "found": 1}
    assert [(v.lat, v.lon, v.geo) for v in first] == [(*HOUSE, "osm")] * 2
    params = asked[0].url.params
    assert (params["countrycodes"], params["bounded"], params["format"]) == ("kz", "1", "jsonv2")
    west, north, east, south = map(float, params["viewbox"].split(","))
    assert south < HOUSE[0] < north and west < HOUSE[1] < east
    saved = json.loads((tmp_path / "geocode.json").read_text("utf-8"))
    assert saved == {"ул. сыганак, 2, алматы": {"p": list(HOUSE), "at": TODAY, "used": TODAY}}
    # Следующий сбор разбирает посты заново: точка приходит из кеша, без запроса
    again = [vacancy("chan_a-1", "ул. Сыганак, 2")]
    stats = locate(again, tmp_path, client)
    assert len(asked) == 1 and stats["cached"] == 1 and (again[0].lat, again[0].geo) == (HOUSE[0], "osm")


def test_vague_or_far_answer_is_no_point(tmp_path):
    street = place(43.25, 76.93, half=0.02)  # улица целиком: рамка в несколько километров
    astana = place(51.128, 71.43)  # нашёлся адрес в другом городе
    asked, client = nominatim({"ул. Абая 10, Алматы": street, "ул. Сыганак, 2, Алматы": astana})
    items = [vacancy("a-1", "ул. Абая 10"), vacancy("a-2", "ул. Сыганак, 2"), vacancy("a-3", "ТЦ Мега")]
    stats = locate(items, tmp_path, client)
    assert len(asked) == 3 and stats["found"] == 0 and all(v.lat is None and v.geo is None for v in items)
    cache = json.loads((tmp_path / "geocode.json").read_text("utf-8"))
    assert {e["p"] for e in cache.values()} == {None}


def test_miss_is_asked_again_only_after_a_month(tmp_path):
    asked, client = nominatim()
    locate([vacancy("a-1", "ул. Абая 10")], tmp_path, client)
    locate([vacancy("a-1", "ул. Абая 10")], tmp_path, client, now=NOW + timedelta(days=10))
    assert len(asked) == 1
    locate([vacancy("a-1", "ул. Абая 10")], tmp_path, client, now=NOW + timedelta(days=31))
    assert len(asked) == 2


def test_budget_goes_to_the_freshest_vacancies(tmp_path):
    asked, client = nominatim()
    items = [vacancy("a-1", "ул. Абая 1", posted="2026-11-01T10:00:00+00:00"),
             vacancy("a-2", "ул. Абая 2", posted="2026-11-04T10:00:00+00:00"),
             vacancy("a-3", "ул. Абая 3", posted="2026-11-03T10:00:00+00:00")]
    stats = locate(items, tmp_path, client, limit=2)
    assert [r.url.params["q"] for r in asked] == ["ул. Абая 2, Алматы", "ул. Абая 3, Алматы"]
    assert stats["asked"] == 2 and "ул. абая 1, алматы" not in json.loads((tmp_path / "geocode.json").read_text())


def test_nominatim_refusal_stops_the_run(tmp_path, caplog):
    asked, client = nominatim(status=429)
    items = [vacancy("a-1", "ул. Абая 1"), vacancy("a-2", "ул. Абая 2")]
    with caplog.at_level(logging.WARNING):
        stats = locate(items, tmp_path, client)
    assert len(asked) == 1 and stats["asked"] == 0 and "HTTP 429" in caplog.text
    assert json.loads((tmp_path / "geocode.json").read_text("utf-8")) == {}  # спросим в следующий прогон


def test_zero_limit_uses_the_cache_without_network(tmp_path, monkeypatch):
    (tmp_path / "geocode.json").write_text(json.dumps({"ул. абая 1, алматы": {"p": list(HOUSE), "at": TODAY}}))
    monkeypatch.setenv("GEOCODE_LIMIT", "0")
    monkeypatch.setattr(httpx, "Client", None)  # клиент не создаётся
    items = [vacancy("a-1", "ул. Абая 1"), vacancy("a-2", "ул. Абая 2")]
    stats = geocode.locate(items, tmp_path, NOW)
    assert stats == {"addresses": 2, "cached": 1, "asked": 0, "found": 1}
    assert (items[0].lat, items[1].lat) == (HOUSE[0], None)


def test_limit_from_env(monkeypatch):
    for value, limit in (("10", 10), ("-5", 0), ("много", geocode.LIMIT)):
        monkeypatch.setenv("GEOCODE_LIMIT", value)
        assert geocode.limit_from_env() == limit
    monkeypatch.delenv("GEOCODE_LIMIT")
    assert geocode.limit_from_env() == geocode.LIMIT


def test_unused_addresses_leave_the_cache(tmp_path):
    old = (NOW - timedelta(days=61)).date().isoformat()
    (tmp_path / "geocode.json").write_text(json.dumps({
        "ул. абая 1, алматы": {"p": list(HOUSE), "at": old, "used": old},
        "ул. абая 2, алматы": {"p": list(HOUSE), "at": old, "used": old},
    }))
    asked, client = nominatim()
    locate([vacancy("a-2", "ул. Абая 2")], tmp_path, client)
    assert list(json.loads((tmp_path / "geocode.json").read_text("utf-8"))) == ["ул. абая 2, алматы"]


def test_channel_vacancy_keeps_its_point_through_collect_runs(tmp_path):
    config = tmp_path / "channels.yaml"
    config.write_text("channels:\n  - username: chan_a\n    city: almaty\n", "utf-8")
    text = "Требуется бариста в кофейню «Зерно», 2/2, 12 000 тг за смену, обучение\nАдрес: ул. Сыганак, 2"
    post = RawPost("telegram", "chan_a", 1, "https://t.me/chan_a/1", text, NOW - timedelta(hours=2), "almaty")
    asked, client = nominatim({"ул. Сыганак, 2, Алматы": place(*HOUSE)})

    def run():
        collect.run(config, tmp_path / "data", fetch=lambda *a, **k: [post], now=NOW,
                    locate=lambda vs, d, now: locate(vs, d, client, now=now))
        return [Vacancy.from_dict(v) for v in json.loads((tmp_path / "data" / "vacancies.json").read_text("utf-8"))]

    run()
    saved = run()  # второй сбор разбирает пост заново, а точка остаётся
    assert len(asked) == 1 and [(v.id, v.lat, v.lon, v.geo) for v in saved] == [("chan_a-1", *HOUSE, "osm")]
    data = appfeed.item(saved[0], "https://vacante.kz", NOW, {})
    assert (data["lat"], data["lon"], data["osm"]) == (*HOUSE, True)

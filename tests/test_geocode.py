import json
import logging
from datetime import datetime, timedelta, timezone

import httpx

from vacante import collect, geocode
from vacante.models import RawPost, Vacancy
from vacante.sources import hh
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


def pieces(*lats, lon=76.93, half=0.003):
    """Ответ Nominatim с dedupe=0: куски одной улицы вдоль широты."""
    return [r for lat in lats for r in place(lat, lon, half)]


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
    placed = vacancy("hh-1", "улица Абая, 150", source="hh")
    placed.lat, placed.lon = HOUSE  # точку поставил сам hh
    assert geocode.query(placed) is None
    # hh точку не поставил: ищем по адресу, как у вакансий из каналов
    assert geocode.query(vacancy("hh-2", "улица Абая, 150", source="hh")) == "улица Абая, 150, Алматы"


def test_address_is_asked_once_and_then_comes_from_the_cache(tmp_path):
    asked, client = nominatim({"ул. Сыганак, 2, Алматы": place(*HOUSE)})
    first = [vacancy("chan_a-1", "ул. Сыганак, 2"), vacancy("chan_b-7", "Ул. Сыганак, 2")]
    stats = locate(first, tmp_path, client)
    assert len(asked) == 1 and stats == {"addresses": 1, "cached": 0, "asked": 1, "requests": 1, "found": 1,
                                         "approx": 0, "failed": 0}
    assert [(v.lat, v.lon, v.geo, v.approx) for v in first] == [(*HOUSE, "osm", False)] * 2
    params = asked[0].url.params
    assert (params["countrycodes"], params["bounded"], params["format"]) == ("kz", "1", "jsonv2")
    west, north, east, south = map(float, params["viewbox"].split(","))
    assert south < HOUSE[0] < north and west < HOUSE[1] < east
    saved = json.loads((tmp_path / "geocode.json").read_text("utf-8"))
    assert saved == {"ул. сыганак, 2, алматы": {"p": list(HOUSE), "at": TODAY, "v": geocode.VERSION, "used": TODAY}}
    # Следующий сбор разбирает посты заново: точка приходит из кеша, без запроса
    again = [vacancy("chan_a-1", "ул. Сыганак, 2")]
    stats = locate(again, tmp_path, client)
    assert len(asked) == 1 and stats["cached"] == 1 and (again[0].lat, again[0].geo) == (HOUSE[0], "osm")


def test_street_without_the_house_gives_the_middle_of_the_whole_street(tmp_path):
    piece = place(43.25, 76.93, half=0.01)  # дом не нашёлся, нашёлся кусок улицы: рамка около 3 км
    asked, client = nominatim({"ул. Абая 10, Алматы": piece, "Абая, Алматы": pieces(43.240, 43.245, 43.250)})
    items = [vacancy("a-1", "ул. Абая 10")]
    stats = locate(items, tmp_path, client)
    assert [r.url.params["q"] for r in asked] == ["ул. Абая 10, Алматы", "Абая, 10, Алматы", "Абая, Алматы"]
    street = asked[2].url.params
    assert (street["layer"], street["limit"], street["dedupe"]) == ("address", "40", "0")  # все куски улицы
    assert (stats["found"], stats["approx"]) == (1, 1)
    # Середина всей улицы (вместе куски меньше 2 км), а не одного куска
    assert (items[0].lat, items[0].lon, items[0].geo, items[0].approx) == (43.245, 76.93, "osm", True)
    entry = json.loads((tmp_path / "geocode.json").read_text("utf-8"))["ул. абая 10, алматы"]
    assert (entry["a"], entry["by"], entry["v"]) == (True, "street", geocode.VERSION)
    again = [vacancy("a-1", "ул. Абая 10")]
    locate(again, tmp_path, client)  # из кеша точка приходит снова примерной
    assert len(asked) == 3 and (again[0].lat, again[0].approx) == (43.245, True)


def test_long_street_gives_no_point_even_if_a_piece_was_found(tmp_path):
    piece = place(43.25, 76.93, half=0.01)  # середина одного куска проспекта: работа может быть в 14 км от неё
    asked, client = nominatim({"ул. Абая 10, Алматы": piece, "Абая, Алматы": pieces(43.20, 43.25, 43.33)})
    items = [vacancy("a-1", "ул. Абая 10")]
    stats = locate(items, tmp_path, client)
    assert len(asked) == 3 and stats["found"] == 0 and items[0].lat is None
    assert json.loads((tmp_path / "geocode.json").read_text("utf-8"))["ул. абая 10, алматы"]["p"] is None


def test_full_page_of_street_pieces_gives_no_point(tmp_path):
    many = pieces(*[43.25] * geocode.STREET_RESULTS, half=0.0005)  # кусков, может быть, ещё больше
    asked, client = nominatim({"Абая, Алматы": many})
    items = [vacancy("a-1", "ул. Абая 10")]
    assert locate(items, tmp_path, client)["found"] == 0 and items[0].lat is None


def test_microdistrict_gives_its_own_approximate_point(tmp_path):
    mkr = place(43.66, 51.15, half=0.01)  # 14 микрорайон целиком: дом не нашёлся
    small = place(43.67, 51.16, half=0.002)  # 12 микрорайон: меньше 1,5 км, но без дома всё равно примерно
    asked, client = nominatim({"14 мкр, 5, Актау": mkr, "12 микрорайон, Актау": small})
    items = [vacancy("a-1", "14 мкр, 5", city="aktau"), vacancy("a-2", "12мкр 79/4", city="aktau")]
    stats = locate(items, tmp_path, client)
    assert [r.url.params["q"] for r in asked] == [
        "14 мкр, 5, Актау", "14 микрорайон, 5, Актау", "14 микрорайон, Актау",
        "12мкр 79/4, Актау", "12 микрорайон, 79/4, Актау", "12 микрорайон, Актау"]
    area = asked[2].url.params  # микрорайон на куски не режется: один ответ из пяти, как у других запасных
    assert (area.get("layer"), area["limit"], area.get("dedupe")) == (None, "5", None)
    assert [(v.lat, v.lon, v.approx) for v in items] == [(43.66, 51.15, True), (43.67, 51.16, True)]
    assert stats["approx"] == 2
    cache = json.loads((tmp_path / "geocode.json").read_text("utf-8"))
    assert ("by" not in cache["14 мкр, 5, актау"], cache["12мкр 79/4, актау"]["by"]) == (True, "area")


def test_nothing_found_is_asked_again_without_ul_and_then_without_the_house_number(tmp_path):
    asked, client = nominatim({"Абая, Алматы": place(43.25, 76.93)})
    items = [vacancy("a-1", "ул. Абая 10")]
    stats = locate(items, tmp_path, client)
    assert [r.url.params["q"] for r in asked] == ["ул. Абая 10, Алматы", "Абая, 10, Алматы", "Абая, Алматы"]
    # Запасные запросы — только среди адресов (не кафе «Абая») и с несколькими ответами для сверки
    assert [(r.url.params.get("layer"), r.url.params["limit"], r.url.params.get("dedupe")) for r in asked] == [
        (None, "1", None), ("address", "5", None), ("address", "40", "0")]
    assert (items[0].lat, items[0].approx, stats["approx"], stats["requests"]) == (43.25, True, 1, 3)
    entry = json.loads((tmp_path / "geocode.json").read_text("utf-8"))["ул. абая 10, алматы"]
    assert (entry["a"], entry["by"]) == (True, "street")  # без номера дома — всегда примерно


def test_avenue_written_as_ul_is_found_without_ul_and_district(tmp_path):
    asked, client = nominatim({"Туран, 55/4, Астана": place(51.1009, 71.4189)})
    items = [vacancy("a-1", "Есильский район, ул. Туран, 55/4, 2 этаж", city="astana")]
    stats = locate(items, tmp_path, client)
    assert [r.url.params["q"] for r in asked] == ["Есильский район, ул. Туран, 55/4, 2 этаж, Астана",
                                                  "ул. Туран, 55/4, Астана", "Туран, 55/4, Астана"]
    assert (items[0].lat, items[0].approx, stats["found"]) == (51.1009, False, 1)  # нашёлся сам дом: точно
    entry = json.loads((tmp_path / "geocode.json").read_text("utf-8"))
    assert entry["есильский район, ул. туран, 55/4, 2 этаж, астана"]["by"] == "bare"


def test_answers_in_different_parts_of_the_city_give_no_point(tmp_path):
    two = place(51.10, 71.42) + place(51.20, 71.55)  # «Туран, 5»: проспект и улица в пригороде, 13 км
    asked, client = nominatim({"Туран, 5, Астана": two, "Туран, Астана": two})
    items = [vacancy("a-1", "ул. Туран 5", city="astana")]
    stats = locate(items, tmp_path, client)
    assert len(asked) == 3 and stats["found"] == 0 and items[0].lat is None


def test_mall_is_found_by_name_and_only_as_a_mall(tmp_path):
    cafe = [{**place(51.15, 71.40)[0], "category": "amenity", "type": "cafe"}]
    mall = [{**place(51.13, 71.43)[0], "category": "shop", "type": "mall"}]
    asked, client = nominatim({"Аружан, Астана": cafe + mall, "Керуен, Астана": cafe})
    items = [vacancy("a-1", "ТРЦ «Аружан», 2 этаж", city="astana"), vacancy("a-2", "ТРЦ Керуен", city="astana")]
    locate(items, tmp_path, client)
    assert [r.url.params["q"] for r in asked] == ["ТРЦ «Аружан», 2 этаж, Астана", "Аружан, Астана",
                                                  "ТРЦ Керуен, Астана", "Керуен, Астана"]
    assert (items[0].lat, items[0].approx, items[1].lat) == (51.13, False, None)  # кафе «Керуен» — не ТРЦ


def test_limit_counts_every_request(tmp_path):
    asked, client = nominatim()
    items = [vacancy("a-1", "ул. Абая 1", posted="2026-11-04T11:00:00+00:00"), vacancy("a-2", "ул. Абая 2")]
    stats = locate(items, tmp_path, client, limit=3)
    assert len(asked) == 3 and (stats["asked"], stats["requests"]) == (1, 3)  # первый адрес и два запасных


def test_too_vague_or_far_answer_is_no_point(tmp_path):
    district = place(43.25, 76.93, half=0.05)  # район или длинная улица: рамка больше 10 км
    astana = place(51.128, 71.43)  # нашёлся адрес в другом городе
    asked, client = nominatim({"ул. Абая 10, Алматы": district, "Абая, Алматы": district,
                               "ул. Сыганак, 2, Алматы": astana, "Сыганак, 2, Алматы": astana})
    items = [vacancy("a-1", "ул. Абая 10"), vacancy("a-2", "ул. Сыганак, 2")]
    stats = locate(items, tmp_path, client)
    assert len(asked) == 6 and stats["found"] == 0 and all(v.lat is None and v.geo is None for v in items)
    cache = json.loads((tmp_path / "geocode.json").read_text("utf-8"))
    assert {e["p"] for e in cache.values()} == {None}


def queries(q, city="almaty"):
    return [(step, text) for step, text, _ in geocode.fallbacks(q, city)]


def test_fallbacks_drop_what_stops_nominatim():
    assert queries("Есильский район, ул. Туран, 55/4, 2 этаж, Астана", "astana") == [
        ("clean", "ул. Туран, 55/4, Астана"), ("bare", "Туран, 55/4, Астана"), ("street", "Туран, Астана")]
    assert queries("проспект Турара Рыскулова, 234, Алматы") == [
        ("bare", "Рыскулова, 234, Алматы"), ("street", "Рыскулова, Алматы")]
    assert queries("ул. Ж. Жабаева, 190а, Петропавловск", "petropavlovsk")[0] == ("bare", "Жабаева, 190а, Петропавловск")
    assert queries("ул. Кабанбай батыра, 5/1, Астана", "astana")[0] == ("bare", "Кабанбай батыра, 5/1, Астана")
    assert queries("ул. Казыбек би, 139, Алматы")[0] == ("bare", "Казыбек би, 139, Алматы")
    assert queries("Курмангазы, 76, столовая 120 гимназии, Алматы") == [
        ("clean", "Курмангазы, 76, Алматы"), ("street", "Курмангазы, Алматы")]
    assert queries("ЖК «Тау Шатыр» ул.Каппарова 6, Алматы")[:2] == [
        ("clean", "ул. Каппарова, 6, Алматы"), ("bare", "Каппарова, 6, Алматы")]
    assert queries("Гоголя 203/73, Алматы") == [("street", "Гоголя, Алматы")]  # без лишнего — тот же адрес


def test_fallbacks_for_microdistricts_and_malls():
    assert queries("12мкр 79/4, Актау", "aktau") == [
        ("clean", "12 микрорайон, 79/4, Актау"), ("area", "12 микрорайон, Актау")]
    assert queries("16-мкр., 85 үй, Актау", "aktau")[0] == ("clean", "16 микрорайон, 85, Актау")
    assert queries("28 мкр, дом 47, ЖК «Гранд Авеню», Актау", "aktau")[0] == ("clean", "28 микрорайон, 47, Актау")
    assert queries("мкр. Самал 2 д. 111, Алматы")[0] == ("clean", "микрорайон Самал 2, 111, Алматы")
    assert queries("Ақсай-5, 25а, Алматы") == []  # микрорайон без слова «микрорайон»: только сам адрес
    assert queries("микрорайон 8, Алматы") == []  # восьмёрка — имя микрорайона, а не дом
    assert queries("Бағанашыл шағын ауданы Подгорная көшесі, 19, Алматы")[1] == (
        "bare", "Бағанашыл микрорайон, Подгорная, 19, Алматы")
    assert queries("мкр. Коянкус ул. Момыш улы 200, Алматы")[1] == ("bare", "микрорайон Коянкус, Момыш улы, 200, Алматы")
    assert queries("ТРЦ «Аружан», Астана", "astana") == [("mall", "Аружан, Астана")]
    assert queries("ТРЦ Forum, Mega, Алматы") == []  # два центра: непонятно, какой


def test_no_fallbacks_for_another_city_or_a_village():
    assert queries("Алматы, проспект Абылай хана, 53, Шымкент", "shymkent") == []  # адрес в другом городе
    assert queries("село Отеген батыр, переулок Жарык, 1, Алматы") == []
    assert queries("Талгар, улица Райымбека, 62, Алматы") == []  # перед улицей непонятное место
    assert queries("Козья ферма, 75 км от Астаны, Астана", "astana") == []
    assert queries("Алматинская область, Кульджинский тракт, 601, Алматы") == []
    assert queries("Нур-Султан, улица Бейбитшилик, 23, Астана", "astana")[0] == ("clean", "улица Бейбитшилик, 23, Астана")


def test_misses_from_the_old_cache_are_asked_again(tmp_path):
    (tmp_path / "geocode.json").write_text(json.dumps({
        "ул. абая 1, алматы": {"p": None, "at": TODAY},  # до примерных точек
        "ул. абая 2, алматы": {"p": None, "at": TODAY, "v": geocode.VERSION},
        "ул. абая 3, алматы": {"p": None, "at": TODAY, "v": 3},  # с запасными запросами: новая версия не найдёт
    }))
    asked, client = nominatim({"ул. Абая 1, Алматы": place(*HOUSE)})
    items = [vacancy("a-1", "ул. Абая 1"), vacancy("a-2", "ул. Абая 2"), vacancy("a-3", "ул. Абая 3")]
    stats = locate(items, tmp_path, client)
    assert [r.url.params["q"] for r in asked] == ["ул. Абая 1, Алматы"] and stats["found"] == 1


def test_old_approximate_points_are_asked_again(tmp_path):
    old = "2026-11-01"
    (tmp_path / "geocode.json").write_text(json.dumps({
        "ул. абая 1, алматы": {"p": [43.25, 76.93], "at": old, "v": 3, "a": True, "by": "street"},  # один кусок
        "ул. абая 2, алматы": {"p": [43.25, 76.93], "at": old, "v": geocode.VERSION, "a": True, "by": "street"},
        "ул. абая 3, алматы": {"p": list(HOUSE), "at": old, "v": 2},  # точная точка: спрашивать незачем
    }))
    asked, client = nominatim({"ул. Абая 1, Алматы": place(*HOUSE)})
    items = [vacancy(f"a-{n}", f"ул. Абая {n}") for n in (1, 2, 3)]
    stats = locate(items, tmp_path, client)
    assert [r.url.params["q"] for r in asked] == ["ул. Абая 1, Алматы"] and (stats["asked"], stats["cached"]) == (1, 2)
    assert [(v.lat, v.approx) for v in items] == [(HOUSE[0], False), (43.25, True), (HOUSE[0], False)]
    entry = json.loads((tmp_path / "geocode.json").read_text("utf-8"))["ул. абая 1, алматы"]
    assert entry == {"p": list(HOUSE), "at": TODAY, "v": geocode.VERSION, "used": TODAY}


def test_old_approximate_point_serves_until_it_is_asked_again(tmp_path):
    (tmp_path / "geocode.json").write_text(json.dumps({
        "ул. абая 1, алматы": {"p": [43.25, 76.93], "at": "2026-11-01", "v": 3, "a": True}}))
    for status, limit in ((429, 60), (200, 0)):  # Nominatim просит подождать; запросы в этот прогон кончились
        asked, client = nominatim(status=status)
        items = [vacancy("a-1", "ул. Абая 1")]
        stats = locate(items, tmp_path, client, limit=limit)
        assert (items[0].lat, items[0].approx, stats["found"]) == (43.25, True, 1)
    entry = json.loads((tmp_path / "geocode.json").read_text("utf-8"))["ул. абая 1, алматы"]
    assert (entry["v"], entry["used"]) == (3, TODAY)  # пересчитаем в следующий прогон


def test_miss_is_asked_again_only_after_a_month(tmp_path):
    asked, client = nominatim()
    locate([vacancy("a-1", "ТЦ Мега")], tmp_path, client)
    locate([vacancy("a-1", "ТЦ Мега")], tmp_path, client, now=NOW + timedelta(days=10))
    assert [r.url.params["q"] for r in asked] == ["ТЦ Мега, Алматы", "Мега, Алматы"]
    locate([vacancy("a-1", "ТЦ Мега")], tmp_path, client, now=NOW + timedelta(days=31))
    assert len(asked) == 4


def test_budget_goes_to_the_freshest_vacancies(tmp_path):
    asked, client = nominatim({f"ул. Абая {n}, Алматы": place(*HOUSE) for n in (1, 2, 3)})
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
    assert len(asked) == 1 and stats["asked"] == 0 and stats["stopped"] == "HTTP 429" and "HTTP 429" in caplog.text
    assert json.loads((tmp_path / "geocode.json").read_text("utf-8")) == {}  # спросим в следующий прогон


def test_zero_limit_uses_the_cache_without_network(tmp_path, monkeypatch):
    (tmp_path / "geocode.json").write_text(json.dumps({"ул. абая 1, алматы": {"p": list(HOUSE), "at": TODAY}}))
    monkeypatch.setenv("GEOCODE_LIMIT", "0")
    monkeypatch.setattr(httpx, "Client", None)  # клиент не создаётся
    items = [vacancy("a-1", "ул. Абая 1"), vacancy("a-2", "ул. Абая 2")]
    stats = geocode.locate(items, tmp_path, NOW)
    assert stats == {"addresses": 2, "cached": 1, "asked": 0, "requests": 0, "found": 1, "approx": 0, "failed": 0}
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
    assert (data["lat"], data["lon"], data["osm"]) == (*HOUSE, True) and "approx" not in data
    saved[0].approx = True
    assert appfeed.item(saved[0], "https://vacante.kz", NOW, {})["approx"] is True


def test_hh_vacancy_without_point_keeps_the_osm_one_until_hh_gives_its_own(tmp_path):
    config = tmp_path / "channels.yaml"
    config.write_text("channels: []\n", "utf-8")
    raw = {"id": "15", "name": "Официант", "area": {"id": "160", "name": "Алматы"},
           "published_at": "2026-11-04T10:00:00+0500", "alternate_url": "https://hh.kz/vacancy/15",
           "address": {"raw": "Алматы, улица Абая, 150"}}
    asked, client = nominatim({"улица Абая, 150, Алматы": place(*HOUSE)})

    def run(found):
        collect.run(config, tmp_path / "data", fetch=None, now=NOW, from_hh=lambda state, now: found,
                    locate=lambda vs, d, now: locate(vs, d, client, now=now))
        [saved] = [Vacancy.from_dict(v) for v in json.loads((tmp_path / "data" / "vacancies.json").read_text("utf-8"))]
        return saved.lat, saved.lon, saved.geo

    assert run([hh.to_vacancy(raw)]) == (*HOUSE, "osm")
    assert run(None) == (*HOUSE, "osm") and len(asked) == 1  # hh не разбирается заново: точка лежит в карточке
    own = {**raw, "address": {"raw": "Алматы, улица Абая, 150", "lat": 43.2401, "lng": 76.9156}}
    assert run([hh.to_vacancy(own)]) == (43.2401, 76.9156, "hh")  # точка самого hh главнее


def test_saved_vacancy_takes_its_osm_point_from_the_cache_every_run(tmp_path):
    config = tmp_path / "channels.yaml"
    config.write_text("channels: []\n", "utf-8")
    raw = {"id": "16", "name": "Повар", "area": {"id": "160", "name": "Алматы"},
           "published_at": "2026-11-04T10:00:00+0500", "alternate_url": "https://hh.kz/vacancy/16",
           "address": {"raw": "Алматы, улица Абая, 150"}}
    asked, client = nominatim({"улица Абая, 150, Алматы": place(*HOUSE)})
    cache = tmp_path / "data" / "geocode.json"

    def run(found=None):
        collect.run(config, tmp_path / "data", fetch=None, now=NOW, from_hh=lambda state, now: found,
                    locate=lambda vs, d, now: locate(vs, d, client, now=now))
        [saved] = [Vacancy.from_dict(v) for v in json.loads((tmp_path / "data" / "vacancies.json").read_text("utf-8"))]
        return saved.lat, saved.lon, saved.geo, saved.approx

    assert run([hh.to_vacancy(raw)]) == (*HOUSE, "osm", False)
    # Точку в кеше пересчитали (новая версия поиска): сохранённая вакансия hh получает новую
    key = "улица абая, 150, алматы"
    cache.write_text(json.dumps({key: {"p": [43.25, 76.93], "at": TODAY, "v": geocode.VERSION, "a": True}}))
    assert run() == (43.25, 76.93, "osm", True)
    cache.write_text(json.dumps({key: {"p": None, "at": TODAY, "v": geocode.VERSION}}))
    assert run() == (None, None, None, False) and len(asked) == 1  # точки больше нет — и у вакансии нет


def flaky(answers):
    """Клиент, у которого ответы по очереди: Response, исключение httpx или функция от запроса."""
    asked = []

    def handle(request):
        asked.append(request.url.params["q"])
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    return asked, httpx.Client(transport=httpx.MockTransport(handle))


def test_timeout_is_retried_once_and_then_left_for_the_next_run(tmp_path):
    waits = []
    timeout = httpx.ReadTimeout("slow")
    asked, client = flaky([timeout, timeout, httpx.Response(200, json=place(*HOUSE))])
    items = [vacancy("a-1", "ул. Абая 1", posted="2026-11-04T11:00:00+00:00"), vacancy("a-2", "ул. Абая 2")]
    stats = geocode.locate(items, tmp_path, NOW, client=client, sleep=waits.append, limit=60)
    assert asked == ["ул. Абая 1, Алматы", "ул. Абая 1, Алматы", "ул. Абая 2, Алматы"]
    assert waits == [geocode.PAUSE, geocode.RETRY_AFTER, geocode.PAUSE]
    assert (stats["asked"], stats["failed"], stats["found"], "stopped" in stats) == (1, 1, 1, False)
    assert (items[0].lat, items[1].lat) == (None, HOUSE[0])
    assert list(json.loads((tmp_path / "geocode.json").read_text("utf-8"))) == ["ул. абая 2, алматы"]


def test_server_error_then_answer_counts_as_asked(tmp_path):
    asked, client = flaky([httpx.Response(503), httpx.Response(200, json=place(*HOUSE))])
    items = [vacancy("a-1", "ул. Абая 1")]
    stats = locate(items, tmp_path, client)
    assert len(asked) == 2 and (stats["asked"], stats["failed"]) == (1, 0) and items[0].lat == HOUSE[0]


def test_nominatim_down_for_three_addresses_stops_the_run(tmp_path, caplog):
    asked, client = flaky([httpx.Response(502)] * 6)
    items = [vacancy(f"a-{n}", f"ул. Абая {n}") for n in range(1, 6)]
    with caplog.at_level(logging.WARNING):
        stats = locate(items, tmp_path, client)
    assert len(asked) == 6 and stats["failed"] == 3 and stats["stopped"] == "HTTP 502 у 3 адресов подряд"
    assert "HTTP 502" in caplog.text and json.loads((tmp_path / "geocode.json").read_text("utf-8")) == {}


def test_bad_request_is_a_miss(tmp_path):
    asked, client = flaky([httpx.Response(400, json={"error": "bad"})] * 2)
    stats = locate([vacancy("a-1", "ТЦ Мега")], tmp_path, client)
    assert asked == ["ТЦ Мега, Алматы", "Мега, Алматы"] and stats["asked"] == 1
    assert json.loads((tmp_path / "geocode.json").read_text("utf-8"))["тц мега, алматы"]["p"] is None


def test_summary_for_the_run_annotation():
    stats = {"addresses": 5, "cached": 2, "asked": 2, "requests": 4, "found": 3, "approx": 1, "failed": 1}
    assert geocode.summary(stats) == ("адресов 5, из кеша 2, спрошено 2 (запросов 4), с точкой 3 (примерной 1), "
                                      "без ответа 1")
    assert geocode.summary({**stats, "stopped": "HTTP 429"}).endswith("; остановлен: HTTP 429")


def test_check_compares_points_with_hh(tmp_path):
    truth = (43.2400, 76.9100)
    hh_ = vacancy("hh-1", "проспект Турара Рыскулова, 234", source="hh")
    hh_.lat, hh_.lon, hh_.geo = *truth, "hh"
    plain = vacancy("hh-2", "улица Абая, 150", source="hh")  # точки hh нет: проверять не с чем
    asked, client = nominatim({"Рыскулова, 234, Алматы": place(43.2410, 76.9110),
                               "Рыскулова, Алматы": place(43.2700, 76.9500, half=0.01)})
    result = geocode.check([hh_, plain], 10, client=client, sleep=lambda s: None)
    assert [r.url.params["q"] for r in asked] == ["проспект Турара Рыскулова, 234, Алматы",
                                                  "Рыскулова, 234, Алматы", "Рыскулова, Алматы"]
    assert result["addresses"] == 1 and result["requests"] == 3 and not (tmp_path / "geocode.json").exists()
    assert result["steps"][""] == [None] and result["steps"]["bare"][0][0] < 0.2
    street = result["steps"]["street"][0]
    assert street[1] is True and 4 < street[0] < 6  # середина улицы — примерно
    lines = geocode.check_report(result)
    assert lines[0] == "адресов 1, запросов 3"
    assert lines[1] == "адрес целиком: спрошено 1, нашлось 0 (примерных 0)"
    assert lines[2].startswith("без «ул.» и имени: спрошено 1, нашлось 1 (примерных 0); от точки hh: медиана 0.1 км")
    assert lines[-1].endswith("· улица без дома · проспект Турара Рыскулова, 234, Алматы")
    assert "по цепочке, как в сборе: спрошено 1, нашлось 1" in lines[4]


def test_check_ladder_takes_the_whole_street_like_collect():
    truth = (43.2400, 76.8700)
    hh_ = vacancy("hh-1", "проспект Райымбека, 312", source="hh")
    hh_.lat, hh_.lon, hh_.geo = *truth, "hh"
    piece = place(43.27, 76.95, half=0.01)  # дом не нашёлся: кусок проспекта в 7 км от работы
    asked, client = nominatim({"проспект Райымбека, 312, Алматы": piece,
                               "Райымбека, Алматы": pieces(43.27, lon=76.80) + pieces(43.27, lon=76.95)})
    result = geocode.check([hh_], 10, client=client, sleep=lambda s: None)
    assert result["requests"] == 3 and 7 < result["steps"][""][0][0] < 7.5 and result["steps"]["street"] == [None]
    assert result["ladder"] == [None]  # проспект длиннее 5 км: точки нет, как и в сборе


def test_check_stops_when_nominatim_is_down():
    items = []
    for n in range(1, 6):
        v = vacancy(f"hh-{n}", f"проспект Абая, {n}", source="hh")
        v.lat, v.lon, v.geo = *HOUSE, "hh"
        items.append(v)
    asked, client = flaky([httpx.Response(502)] * 6)
    result = geocode.check(items, 5, client=client, sleep=lambda s: None)
    assert len(asked) == 6 and result["addresses"] == 0 and result["stopped"] == "HTTP 502 у 3 адресов подряд"

import json
from datetime import datetime, timedelta, timezone

import httpx

from vacante import collect
from vacante.sources import olx
from vacante.store import load_vacancies

NOW = datetime(2026, 11, 5, 8, tzinfo=timezone.utc)


def offer(id_, title="Требуется официант", city="Алматы", created="2026-11-05T10:00:00+05:00", salary=None, **extra):
    data = {
        "id": id_, "url": f"https://www.olx.kz/d/obyavlenie/oficiant-ID{id_}.html", "title": title,
        "description": "Кафе в центре ищет официанта.<br />График 2/2, питание.<br />Звоните +7 777 123 45 67",
        "created_time": created, "last_refresh_time": created, "offer_type": "offer",
        "params": [{"key": "salary", "name": "Зарплата", "type": "salary", "value": salary}] if salary else [],
        "location": {"city": {"id": 1, "name": city, "normalized_name": "almaty"}},
        "map": {"lat": 43.2389, "lon": 76.8897, "show_detailed": True},
        "user": {"name": "Анна"}, "contact": {"name": "Анна", "phone": True},
        "category": {"id": 6, "type": "job"},
    }
    data.update(extra)
    return data


def no_sleep(_):
    pass


def client(handler):
    return httpx.Client(base_url=olx.BASE, transport=httpx.MockTransport(handler))


def test_vacancy_has_link_and_no_contacts():
    v = olx.to_vacancy(offer(101, salary={"from": 200000, "to": 250000, "currency": "KZT", "type": "monthly"}))
    assert (v.id, v.source, v.city, v.title) == ("olx-101", "olx", "almaty", "Официант")
    assert v.source_url == "https://www.olx.kz/d/obyavlenie/oficiant-ID101.html"
    assert (v.salary_min, v.salary_max, v.salary_period) == (200000, 250000, "month")
    assert v.schedule == "2/2" and "Питание" in v.perks
    assert (v.lat, v.geo) == (43.2389, "olx")
    assert v.posted_at == "2026-11-05T05:00:00+00:00"
    dumped = json.dumps(v.to_dict(), ensure_ascii=False)
    assert "777" not in dumped and "Анна" not in dumped


def test_skips_resumes_office_and_unknown_cities():
    assert olx.to_vacancy(offer(102, offer_type="seek")) is None
    assert olx.to_vacancy(offer(103, title="Требуется бухгалтер")) is None
    assert olx.to_vacancy(offer(104, city="Бишкек")) is None
    assert olx.to_vacancy(offer(105, url="https://evil.example/x")) is None
    usd = olx.to_vacancy(offer(106, salary={"from": 500, "currency": "USD", "type": "monthly"}))
    assert usd is not None and usd.salary_min is None


def test_rough_map_point_not_used():
    v = olx.to_vacancy(offer(107, map={"lat": 43.2389, "lon": 76.8897, "show_detailed": False}))
    assert v.lat is None and v.geo is None


def test_collect_pages_until_window_and_remembers_it(monkeypatch):
    monkeypatch.setenv("OLX_SOURCE_ENABLED", "true")
    monkeypatch.setattr(olx, "LIMIT", 2)
    seen = []

    def handler(request):
        if request.url.path == "/api/v1/categories/":
            return httpx.Response(200, json={"data": [{"id": 1, "parent_id": 0, "name": "Электроника"},
                                                      {"id": 6, "parent_id": 0, "name": "Работа", "type": "job"}]})
        assert request.url.params["category_id"] == "6"
        offset = int(request.url.params["offset"])
        seen.append(offset)
        old = (NOW - timedelta(days=5)).isoformat()
        pages = {0: [offer(1), offer(2)], 2: [offer(3), offer(4, created=old)], 4: [offer(5)]}
        return httpx.Response(200, json={"data": pages[offset]})

    state = {}
    found = olx.collect_api(state, NOW, client(handler), no_sleep)
    assert seen == [0, 2]  # дальше окна не листаем
    assert {v.id for v in found} == {"olx-1", "olx-2", "olx-3", "olx-4"}
    assert state["olx_checked_at"] == NOW.isoformat() and state["olx_status"] == "ok"


def test_blocked_is_skipped_not_bypassed(monkeypatch):
    monkeypatch.setenv("OLX_SOURCE_ENABLED", "true")
    monkeypatch.setenv("OLX_CATEGORY_ID", "6")
    calls = []

    def captcha(request):
        calls.append(request)
        return httpx.Response(200, text="<html>Подтвердите, что вы не робот</html>")

    state = {}
    assert olx.collect_api(state, NOW, client(captcha), no_sleep) is None
    assert len(calls) == 1 and state["olx_status"].startswith("blocked") and "olx_checked_at" not in state

    forbidden = client(lambda r: httpx.Response(403))
    assert olx.collect_api(state, NOW, forbidden, no_sleep) is None


def test_disabled_by_default(monkeypatch):
    monkeypatch.delenv("OLX_SOURCE_ENABLED", raising=False)
    assert olx.collect_api({}, NOW, client(lambda r: 1 / 0), no_sleep) is None


def test_pipeline_keeps_olx_vacancies(tmp_path):
    config = tmp_path / "channels.yaml"
    config.write_text("channels: []\n", "utf-8")
    data = tmp_path / "data"
    found = [olx.to_vacancy(offer(9))]
    stats = collect.run(config, data, fetch=None, now=NOW, from_hh=lambda s, n: None, from_olx=lambda s, n: found)
    assert [v.id for v in load_vacancies(data)] == ["olx-9"] and stats["olx"] == 1
    stats = collect.run(config, data, fetch=None, now=NOW, from_hh=lambda s, n: None, from_olx=lambda s, n: None)
    assert [v.id for v in load_vacancies(data)] == ["olx-9"] and "olx" not in stats


def test_honest_user_agent():
    with olx.make_client() as c:
        assert c.headers["User-Agent"].startswith("vacante.kz/") and "vacante.kz" in olx.USER_AGENT


def test_via_own_server_reads_olx_status(monkeypatch):
    monkeypatch.setenv("OLX_VIA", "https://api.vacante.kz/")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:abc")
    with olx.make_client() as c:
        assert str(c.base_url) == "https://api.vacante.kz/internal/olx/"
        assert c.headers["Authorization"].startswith("Bearer ") and len(c.headers["Authorization"]) == 71
    via = httpx.Client(base_url="https://api.vacante.kz/internal/olx", transport=httpx.MockTransport(
        lambda r: httpx.Response(200, headers={"X-Olx-Status": "403"}, text="denied")))
    try:
        olx.get(via, "/api/v1/categories/", None, no_sleep)
        raise AssertionError("ждали Blocked")
    except olx.Blocked as exc:
        assert "403" in str(exc)
    ok = httpx.Client(base_url="https://api.vacante.kz/internal/olx", transport=httpx.MockTransport(
        lambda r: httpx.Response(200, headers={"X-Olx-Status": "200"}, json={"data": []})))
    assert olx.get(ok, "/api/v1/categories/", None, no_sleep) == {"data": []}


def test_imports_from_own_server_even_when_olx_blocks(monkeypatch):
    monkeypatch.setenv("OLX_SOURCE_ENABLED", "true")
    monkeypatch.setenv("OLX_VIA", "https://api.vacante.kz")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:abc")
    monkeypatch.setenv("OLX_CATEGORY_ID", "6")
    asked = []

    def handler(request):
        if request.url.path.endswith("/internal/olx/imports"):
            asked.append(request.url.params["since"])
            item = offer(11, created="2026-11-04T05:00:00.000Z", imported_at="2026-11-05T07:00:00.000Z")
            return httpx.Response(200, json={"data": [item]})
        return httpx.Response(200, headers={"X-Olx-Status": "403"}, text="denied")  # выдача OLX роботу закрыта

    via = httpx.Client(base_url="https://api.vacante.kz/internal/olx", transport=httpx.MockTransport(handler))
    state = {}
    found = olx.collect_api(state, NOW, via, no_sleep)
    assert [v.id for v in found] == ["olx-11"] and found[0].posted_at == "2026-11-04T05:00:00+00:00"
    assert state["olx_status"].startswith("blocked") and "olx_checked_at" not in state
    assert state["olx_imports_at"] == NOW.isoformat()
    assert asked == [(NOW - olx.IMPORTS_FIRST).isoformat(timespec="seconds")]
    olx.collect_api(state, NOW + timedelta(hours=1), via, no_sleep)
    assert asked[1] == (NOW - olx.OVERLAP).isoformat(timespec="seconds")

    # Сервер не отдал объявления (например, не тот ключ) и OLX закрыт: источник пропускает запуск
    denied = httpx.Client(base_url="https://api.vacante.kz/internal/olx", transport=httpx.MockTransport(
        lambda r: httpx.Response(403)))
    assert olx.collect_api(dict(state), NOW, denied, no_sleep) is None


def test_imported_phone_flag_only_and_removal():
    from vacante.store import merge
    v = olx.to_vacancy(offer(123, has_phone=True))
    assert v.contact == ["phone"]
    assert "777" not in json.dumps(v.to_dict())
    # The raw API phone availability flag alone cannot promise a retrievable contact.
    assert olx.to_vacancy(offer(124)).contact == []
    updated = olx.to_vacancy(offer(123, has_phone=False))
    assert merge([v], [updated])[0].contact == []

import json
from datetime import datetime, timedelta, timezone

import httpx

from vacante import collect
from vacante.sources import hh
from vacante.store import load_vacancies

NOW = datetime(2026, 10, 28, 8, tzinfo=timezone.utc)


def item(id_, name="Официант", area="Алматы", salary=None, **extra):
    data = {
        "id": str(id_), "name": name, "area": {"id": "160", "name": area},
        "salary_range": salary, "published_at": "2026-10-28T10:00:00+0500",
        "alternate_url": f"https://hh.kz/vacancy/{id_}",
        "employer": {"id": "1", "name": "Кафе «Зерно»"},
        "address": {"raw": "Алматы, улица Жибек Жолы, 65"},
        "schedule": {"id": "shift", "name": "Сменный график"},
        "snippet": {"requirement": "Опыт <highlighttext>официантом</highlighttext> от года.",
                    "responsibility": "Обслуживание гостей. Питание за счёт компании."},
        # Контакты в выдаче быть не должны, но даже если придут, мы их не берём
        "contacts": {"name": "Анна", "email": "hr@zerno.kz", "phones": [{"formatted": "+7 777 000 00 00"}]},
    }
    data.update(extra)
    return data


def client(handler):
    return httpx.Client(base_url=hh.API, transport=httpx.MockTransport(handler))


def no_sleep(_):
    pass


def test_vacancy_has_only_public_fields():
    v = hh.to_vacancy(item(1, salary={"from": 250000, "to": None, "currency": "KZT", "mode": {"id": "MONTH"}}))
    assert (v.id, v.title, v.employer, v.city, v.address) == (
        "hh-1", "Официант", "Кафе «Зерно»", "almaty", "улица Жибек Жолы, 65")
    assert (v.salary_min, v.salary_max, v.salary_period) == (250000, None, "month")
    assert (v.source, v.source_url, v.posted_at) == ("hh", "https://hh.kz/vacancy/1", "2026-10-28T05:00:00+00:00")
    assert "Питание" in v.perks and "highlighttext" not in v.text
    dumped = json.dumps(v.to_dict(), ensure_ascii=False)
    assert "hr@zerno.kz" not in dumped and "Анна" not in dumped and "777" not in dumped


def test_skips_office_foreign_city_and_odd_salary():
    assert hh.to_vacancy(item(2, name="Бухгалтер")) is None
    assert hh.to_vacancy(item(3, area="Москва")) is None
    v = hh.to_vacancy(item(4, salary={"from": 12000, "currency": "KZT", "mode": {"id": "SHIFT"}}))
    assert (v.salary_min, v.salary_period) == (12000, "day")
    usd = hh.to_vacancy(item(5, salary={"from": 1000, "currency": "USD", "mode": {"id": "MONTH"}}))
    assert usd.salary_min is None and usd.salary_period is None


def test_skips_work_abroad_with_kazakh_area():
    assert hh.to_vacancy(item(6, name="Хостес в клуб (Турция)")) is None
    assert hh.to_vacancy(item(7, name="Комплектовщик-упаковщик, вахта Москва! 7000р за смену")) is None
    assert hh.to_vacancy(item(8, name="Курьер на электровелосипед (Вахта)", snippet={
        "responsibility": "Доставляйте заказы в различных городах России."})) is None
    assert hh.to_vacancy(item(9, name="Продавец-консультант (Алматы, ТРЦ Москва)")) is not None

def test_search_splits_windows_over_2000_and_pages():
    calls = []

    def handler(request):
        p = request.url.params
        calls.append((p["date_from"], p["page"]))
        start = datetime.fromisoformat(p["date_from"])
        end = datetime.fromisoformat(p["date_to"])
        if end - start > timedelta(hours=12):
            return httpx.Response(200, json={"found": 3000, "pages": 20, "items": []})
        page = int(p["page"])
        return httpx.Response(200, json={"found": 150, "pages": 2, "items": [item(f"{start:%H}{page}")]})

    items = hh.search(client(handler), NOW - timedelta(days=1), NOW, no_sleep)
    assert len(items) == 4  # два окна по 12 часов, в каждом две страницы
    assert all(c[1] in ("0", "1") for c in calls)


def test_retries_429_then_succeeds():
    answers = iter([httpx.Response(429), httpx.Response(200, json={"found": 1, "pages": 1, "items": [item(7)]})])
    assert len(hh.search(client(lambda r: next(answers)), NOW - timedelta(hours=1), NOW, no_sleep)) == 1


def test_disabled_by_default(monkeypatch):
    monkeypatch.delenv("HH_SOURCE_ENABLED", raising=False)
    assert hh.collect({}, NOW, client(lambda r: httpx.Response(500)), no_sleep) is None


def test_403_disables_source_without_failing(monkeypatch, caplog):
    monkeypatch.setenv("HH_SOURCE_ENABLED", "true")
    state = {}
    assert hh.collect(state, NOW, client(lambda r: httpx.Response(403, text="forbidden")), no_sleep) is None
    assert "hh_checked_at" not in state
    assert "403" in caplog.text


def test_collect_remembers_window(monkeypatch):
    monkeypatch.setenv("HH_SOURCE_ENABLED", "true")
    seen = []

    def handler(request):
        seen.append(request.url.params["date_from"])
        assert request.url.params["host"] == "hh.kz"
        return httpx.Response(200, json={"found": 1, "pages": 1, "items": [item(8)]})

    state = {}
    assert [v.id for v in hh.collect(state, NOW, client(handler), no_sleep)] == ["hh-8"]
    assert seen[0] == (NOW - hh.FIRST_RUN).isoformat()
    hh.collect(state, NOW + timedelta(hours=1), client(handler), no_sleep)
    assert seen[1] == (NOW - hh.OVERLAP).isoformat()


def test_pipeline_keeps_hh_vacancies_and_survives_403(tmp_path):
    config = tmp_path / "channels.yaml"
    config.write_text("channels: []\n", "utf-8")
    data = tmp_path / "data"
    found = [hh.to_vacancy(item(9))]
    collect.run(config, data, fetch=None, now=NOW, from_hh=lambda state, now: found)
    assert [v.id for v in load_vacancies(data)] == ["hh-9"]
    stats = collect.run(config, data, fetch=None, now=NOW, from_hh=lambda state, now: None)  # 403 или выключен
    assert [v.id for v in load_vacancies(data)] == ["hh-9"] and "hh" not in stats


def token_transport(status=200, body=None, seen=None):
    def handler(request):
        if seen is not None:
            seen.append(request)
        return httpx.Response(status, json=body if body is not None else {"access_token": "APP", "token_type": "bearer"})
    return httpx.MockTransport(handler)


def test_app_token_by_client_credentials(monkeypatch):
    monkeypatch.delenv("HH_TOKEN", raising=False)
    monkeypatch.setenv("HH_CLIENT_ID", "id")
    monkeypatch.setenv("HH_CLIENT_SECRET", "secret")
    seen = []
    assert hh.token_from_env(token_transport(seen=seen)) == "APP"
    request = seen[0]
    assert request.method == "POST" and request.url.path == "/token"
    assert dict(httpx.QueryParams(request.content.decode())) == {
        "grant_type": "client_credentials", "client_id": "id", "client_secret": "secret"}


def test_hh_token_wins_and_no_secrets_means_anonymous(monkeypatch):
    monkeypatch.setenv("HH_TOKEN", "OWN")
    monkeypatch.setenv("HH_CLIENT_ID", "id")
    monkeypatch.setenv("HH_CLIENT_SECRET", "secret")
    assert hh.token_from_env(token_transport(500)) == "OWN"
    for name in ("HH_TOKEN", "HH_CLIENT_ID", "HH_CLIENT_SECRET"):
        monkeypatch.delenv(name)
    assert hh.token_from_env(token_transport(500)) is None


def test_bad_client_secret_skips_source(monkeypatch, caplog):
    monkeypatch.setenv("HH_SOURCE_ENABLED", "true")
    monkeypatch.delenv("HH_TOKEN", raising=False)
    monkeypatch.setenv("HH_CLIENT_ID", "id")
    monkeypatch.setenv("HH_CLIENT_SECRET", "wrong")
    real = hh.app_token
    monkeypatch.setattr(hh, "app_token", lambda i, s, a=None, t=None: real(
        i, s, a, token_transport(400, {"error": "invalid_client"})))
    state = {}
    assert hh.collect(state, NOW, sleep=no_sleep) is None
    assert "hh_checked_at" not in state
    assert "invalid_client" in caplog.text and "wrong" not in caplog.text


def test_schedule_from_new_fields():
    v = hh.to_vacancy(item(9, schedule=None, work_schedule_by_days=[{"id": "TWO_ON_TWO_OFF", "name": "2/2"}],
                           working_hours=[{"id": "HOURS_12", "name": "12 часов"}]))
    assert v.schedule == "2/2, 12 часов"
    assert hh.to_vacancy(item(10, schedule=None)).schedule is None
    assert hh.to_vacancy(item(11)).schedule == "Сменный график"


def test_bilingual_title_goes_russian_with_kazakh_kept():
    v = hh.to_vacancy(item(9, name="Сату менеджер/менеджер по продажам ZERFARM"))
    assert (v.title, v.title_kk) == ("Менеджер по продажам ZERFARM", "Сату менеджер")
    assert hh.to_vacancy(item(10)).title_kk is None

import json
from datetime import datetime, timedelta, timezone

import httpx

from vacante import crm_sync, venues
from vacante.models import RawPost
from vacante.parse import parse_post

NOW = datetime(2026, 11, 6, 7, tzinfo=timezone.utc)
TEXT = "💼 {title}\n{employer}\n💰 300 000 ₸\n📍 {city}\n\nТребуется сотрудник в кофейню."


def make(post_id: int, title: str, employer: str, city: str, slug: str, hours_ago: int = 1):
    v = parse_post(RawPost("telegram", "chan", post_id, f"https://t.me/chan/{post_id}",
                           TEXT.format(title=title, employer=employer, city=city), NOW - timedelta(hours=hours_ago), slug))
    assert v is not None and v.employer
    return v


def test_snapshot_groups_venues_of_one_employer_across_cities(tmp_path):
    venues.save(tmp_path, {"almaty:greenwich": {"status": "found", "instagram": "greenwich.kz",
                                                "avatar": "0123456789abcdef.jpg"}})
    vacancies = [make(1, "Бариста", "Greenwich", "Алматы", "almaty"),
                 make(2, "Официант", "ТОО «Greenwich»", "Алматы", "almaty", hours_ago=3),
                 make(3, "Бариста", "Greenwich", "Астана", "astana"),
                 make(4, "Повар", "DINO FEST", "Алматы", "almaty")]
    employers = {e["key"]: e for e in crm_sync.snapshot(tmp_path, vacancies)}
    assert set(employers) == {"greenwich", "dino fest"}
    g = employers["greenwich"]
    assert g["name"] == "Greenwich"
    by_city = {v["city"]: v for v in g["venues"]}
    assert set(by_city) == {"almaty", "astana"}
    almaty = by_city["almaty"]
    assert almaty["key"] == "almaty:greenwich"
    assert almaty["instagram"] == "greenwich.kz" and almaty["avatar"] == "0123456789abcdef.jpg"
    assert [v["id"] for v in almaty["vacancies"]] == [vacancies[0].id, vacancies[1].id]  # свежие первыми
    assert almaty["twogis"].startswith("https://2gis.kz/almaty/search/")
    assert by_city["astana"]["instagram"] is None


def test_send_archives_only_after_whole_snapshot(monkeypatch):
    calls = []

    def handler(request):
        body = json.loads(request.content)
        calls.append((request.url.path, request.headers["authorization"], body))
        if request.url.path.endswith("/import"):
            return httpx.Response(200, json={"employers": len(body["employers"]), "venues": 1, "vacancies": 1})
        return httpx.Response(200, json={"archived": 2, "active": 5})

    monkeypatch.setattr(crm_sync, "CHUNK", 2)
    key = crm_sync.internal_key("123:abc")
    client = httpx.Client(base_url="https://api.test", transport=httpx.MockTransport(handler),
                          headers={"Authorization": f"Bearer {key}"})
    employers = [{"key": str(i), "name": str(i), "venues": []} for i in range(5)]
    stats = crm_sync.send(client, employers, NOW)
    assert [c[0] for c in calls] == ["/internal/crm/import"] * 3 + ["/internal/crm/finish"]
    assert {c[2]["run_at"] for c in calls} == {"2026-11-06T07:00:00+00:00"}
    assert stats["sent"]["employers"] == 5 and stats["archived"] == 2
    assert calls[0][1] == f"Bearer {key}"


def test_run_without_bot_token_does_nothing(tmp_path, monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    assert crm_sync.run(tmp_path, []) is None


class FakeD1:
    def __init__(self, crm_ok=True):
        self.crm_ok = crm_ok

    def query(self, sql, params=None):
        if "FROM jobs" in sql:
            return [{"id": 7, "employer_chat": 555, "employer_name": "Айгуль @aigul", "company": "ТОО «Greenwich»", "city": "almaty"},
                    {"id": 8, "employer_chat": 556, "employer_name": None, "company": "", "city": "astana"}]
        if "FROM payments" in sql:
            return [{"id": 1, "job_id": 7, "kind": "post", "amount": 900, "status": "paid",
                     "created_at": "2026-11-06 10:00:00", "decided_at": "2026-11-06 10:05:00",
                     "company": "ТОО «Greenwich»", "city": "almaty"}]
        if "FROM crm" in sql:
            if not self.crm_ok:
                raise RuntimeError("no such table: crm")
            return [{"venue": "almaty:greenwich", "status": "contacted", "note": "звонили", "contacted_at": "2026-11-01 13:27:32"}]
        raise AssertionError(sql)


def test_from_bot_keys_jobs_and_payments_like_snapshot():
    data = crm_sync.from_bot(FakeD1())
    job = data["jobs"][0]
    assert job["job_id"] == 7 and job["chat"] == 555
    assert job["venue_key"] == "almaty:greenwich" and job["employer_key"] == "greenwich"
    assert data["jobs"][1]["employer_key"] is None
    pay = data["payments"][0]
    assert pay["kind"] == "post" and pay["amount"] == 900 and pay["at"] == "2026-11-06T10:05:00+00:00"
    assert data["marks"]["almaty:greenwich"]["contacted_at"] == "2026-11-01T13:27:32+00:00"
    assert crm_sync.from_bot(FakeD1(crm_ok=False))["marks"] == {}


def test_hh_companies_reads_logo_site_and_plain_about():
    def handler(request):
        if request.url.path.endswith("/1"):
            return httpx.Response(200, json={"logo_urls": {"90": "https://img/90.png", "240": "https://img/240.png"},
                                             "site_url": "https://greenwich.kz",
                                             "description": "<p>Сеть&nbsp;кофеен &laquo;Greenwich&raquo;</p>\n<ul><li>Алматы</li></ul>"})
        return httpx.Response(404, json={})

    client = httpx.Client(base_url="https://api.hh.ru", transport=httpx.MockTransport(handler))
    out = crm_sync.hh_companies(client, ["1", "2"])
    assert out[0] == {"id": "1", "logo": "https://img/240.png", "site": "https://greenwich.kz",
                      "about": "Сеть кофеен «Greenwich» Алматы"}
    assert out[1] == {"id": "2"}

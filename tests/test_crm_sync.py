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

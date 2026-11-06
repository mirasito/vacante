import json
from datetime import datetime, timezone

import httpx

from vacante.sources.olx_web import collect_web


def test_hourly_listing_and_private_contact():
    now = datetime(2026, 11, 6, tzinfo=timezone.utc)
    ad = {"id": 42, "isJob": True, "title": "Требуется пекарь", "url": "https://www.olx.kz/obyavlenie/rabota/pekar-IDabc.html",
          "createdTime": now.isoformat(), "description": "Ночная смена. Звоните +7 701 000 00 00",
          "location": {"cityName": "Алматы"}, "salary": {"from": 250000, "currencyCode": "KZT", "period": "monthly"}}
    calls = []

    def page(req):
        assert "authorization" not in req.headers
        n = int(req.url.params.get("page", 1))
        calls.append(n)
        state = {"listing": {"listing": {"ads": [ad], "pageNumber": n - 1, "totalPages": 2}}}
        return httpx.Response(200, text="window.__PRERENDERED_STATE__= " + json.dumps(json.dumps(state)))

    def save(req):
        assert req.url.path == "/internal/olx/batch"
        assert json.loads(req.content)["items"][0]["city"] == "Алматы"
        return httpx.Response(200, json={"phone_ids": [42]})

    with httpx.Client(transport=httpx.MockTransport(page)) as public, httpx.Client(
        base_url="https://api.vacante.kz/internal/olx", transport=httpx.MockTransport(save)
    ) as private:
        state = {}
        rows = collect_web(state, now, public, private, sleep=lambda _: None)
    assert calls == [1, 2]
    assert len(rows) == 1 and rows[0].contact == ["phone"] and rows[0].salary_min == 250000
    assert "701" not in rows[0].text and state["olx_status"] == "ok"


def test_denial_does_not_advance_last_success():
    state = {"olx_checked_at": "previous"}
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(403))) as public:
        assert collect_web(state, datetime.now(timezone.utc), public, None) is None
    assert state["olx_status"] == "HTTP 403" and state["olx_checked_at"] == "previous"

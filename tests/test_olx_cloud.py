from datetime import datetime, timezone
import hashlib
import json
import httpx
import pytest
from vacante.sources import olx_cloud


def test_grant_contains_only_verifier(tmp_path):
    olx_cloud.prepare(tmp_path, datetime.now(timezone.utc))
    token = (tmp_path / "token").read_text()
    grant = json.loads((tmp_path / "olx-grant.json").read_text())
    assert set(grant) == {"sha256", "expires_at"}
    assert hashlib.sha256(token.encode()).hexdigest() == grant["sha256"]
    assert token not in str(grant)
    assert (tmp_path / "token").stat().st_mode & 0o077 == 0
    with pytest.raises(FileExistsError):
        olx_cloud.prepare(tmp_path, datetime.now(timezone.utc))


def test_worker_sends_only_to_vacante():
    seen = set()
    def save(req):
        assert str(req.url) == olx_cloud.API
        rows = json.loads(req.content)["items"]
        ids = {r["id"] for r in rows}
        new = len(ids - seen)
        seen.update(ids)
        return httpx.Response(200, json={"stored": len(rows), "inserted": new, "phone_ids": []})
    with httpx.Client(transport=httpx.MockTransport(save)) as client:
        rows = [{"id": i} for i in range(63)]
        assert olx_cloud.upload(client, rows) == 63
        assert olx_cloud.upload(client, rows) == 0

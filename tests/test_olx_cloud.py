from datetime import datetime, timedelta, timezone

import httpx
import pytest
from nacl.exceptions import CryptoError
from nacl.public import PrivateKey

from vacante.sources import olx_cloud


def test_private_batch_delivery(tmp_path):
    now = datetime.now(timezone.utc)
    key = PrivateKey.generate()
    rows = [{"id": i, "description": "Звоните +7 701 000 00 00"} for i in range(63)]
    sealed = olx_cloud.pack(rows, now, key.public_key)
    assert "701 000" not in sealed
    with pytest.raises(CryptoError):
        olx_cloud.unpack(sealed, now, PrivateKey.generate())
    with pytest.raises(ValueError, match="Expired"):
        olx_cloud.unpack(sealed, now + timedelta(hours=5), key)
    p = tmp_path / "snapshot"
    p.write_text(sealed)
    saved = {}
    def store(request):
        import json
        batch = json.loads(request.content)["items"]
        saved.update((r["id"], r) for r in batch)
        return httpx.Response(200, json={"stored": len(batch), "phone_ids": []})
    with httpx.Client(base_url="https://api.vacante.kz/internal/olx/", transport=httpx.MockTransport(store)) as c:
        for _ in range(2):
            assert olx_cloud.deliver(p, c, key, now) == len(rows)
            assert len(saved) == len(rows)

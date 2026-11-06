"""Producer holds only a public key. The trusted receiver upserts by OLX id."""
import argparse
import base64
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import hmac
import io
import json
import os
from pathlib import Path

import httpx
from nacl.public import PrivateKey, PublicKey, SealedBox

from vacante.sources import olx
from vacante.sources.olx_web import collect_web

MAX_BYTES = 3_000_000
SNAPSHOT = "olx-inbox.sealed"
PUBKEY = Path(__file__).resolve().parents[2] / "config" / "olx-cloud.pub"


def receiver_key():
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    if not token:
        raise ValueError("Missing receiver secret")
    return PrivateKey(hmac.digest(token.encode(), b"vacante/olx/sealed-inbox/v1", "sha256"))


def pack(rows, now, recipient):
    plain = json.dumps({"version": 1, "created": now.isoformat(), "items": rows},
                       ensure_ascii=False, separators=(",", ":")).encode()
    if len(plain) > MAX_BYTES:
        raise ValueError("Batch too large")
    return base64.b64encode(SealedBox(recipient).encrypt(gzip.compress(plain))).decode() + "\n"


def unpack(content, now, key):
    if len(content) > MAX_BYTES:
        raise ValueError("Envelope too large")
    zipped = SealedBox(key).decrypt(base64.b64decode(content.strip(), validate=True))
    with gzip.GzipFile(fileobj=io.BytesIO(zipped)) as stream:
        plain = stream.read(MAX_BYTES + 1)
    if len(plain) > MAX_BYTES:
        raise ValueError("Payload too large")
    data = json.loads(plain)
    stamp = datetime.fromisoformat(data["created"])
    if data["version"] != 1 or not now - timedelta(hours=4) <= stamp <= now + timedelta(minutes=5):
        raise ValueError("Expired or unsupported envelope")
    rows = data["items"]
    if not isinstance(rows, list) or len(rows) > 1000:
        raise ValueError("Invalid batch")
    return rows


def produce(path, pages, pubkey):
    rows, state = [], {}
    with httpx.Client(headers={"User-Agent": olx.USER_AGENT, "Accept": "text/html"}, timeout=30) as public:
        collect_web(state, datetime.now(timezone.utc), public, None, max_pages=pages, on_batch=rows.extend)
    if state["olx_status"] != "ok":
        raise SystemExit(f"OLX: {state['olx_status']}, pages={state['olx_pages']}. Snapshot not published.")
    path.write_text(pack(rows, datetime.now(timezone.utc), pubkey), encoding="ascii")
    print(f"pages={state['olx_pages']} jobs={len(rows)} sha256={hashlib.sha256(path.read_bytes()).hexdigest()}")


def deliver(path, server, key, now):
    rows = unpack(path.read_text(encoding="ascii"), now, key)
    stored = phones = 0
    for offset in range(0, len(rows), 40):
        batch = rows[offset:offset+40]
        response = server.post("batch", json={"items": batch})
        response.raise_for_status()
        result = response.json()
        if result["stored"] != len(batch):
            raise ValueError("Incomplete import")
        stored += result["stored"]
        phones += len(result["phone_ids"])
    print(f"stored={stored} with_phone={phones}")
    return stored


def main():
    args = argparse.ArgumentParser()
    args.add_argument("mode", choices=["public-key", "produce", "deliver"])
    args.add_argument("--file", type=Path, default=Path(SNAPSHOT))
    args.add_argument("--pages", type=int, choices=range(1, 26), default=5)
    a = args.parse_args()
    if a.mode == "public-key":
        print("OLX_RECIPIENT=" + bytes(receiver_key().public_key).hex())
    elif a.mode == "produce":
        produce(a.file, a.pages, PublicKey(bytes.fromhex(PUBKEY.read_text().strip())))
    else:
        if not olx.via_server():
            raise SystemExit("Vacante server credentials required")
        with olx.make_client() as server:
            deliver(a.file, server, receiver_key(), datetime.now(timezone.utc))


if __name__ == "__main__":
    main()

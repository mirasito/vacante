"""Scheduled worker: publish only the random token's hash, upload job data directly to Vacante."""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import time

import httpx

from vacante.sources import olx
from vacante.sources.olx_web import collect_web

API = "https://api.vacante.kz/olx/worker/import"


def prepare(folder, now):
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    token = secrets.token_hex(32)
    # Exclusive creation prevents a token from being overwritten during an overlapping run.
    with os.fdopen(os.open(folder / "token", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as f:
        f.write(token)
    grant = {"sha256": hashlib.sha256(token.encode()).hexdigest(),
             "expires_at": (now + timedelta(minutes=20)).isoformat()}
    (folder / "olx-grant.json").write_text(json.dumps(grant) + "\n")


def upload(client, rows):
    inserted = phones = 0
    for offset in range(0, len(rows), 40):
        batch = rows[offset:offset+40]
        for attempt in range(3):
            try:
                response = client.post(API, json={"items": batch})
                response.raise_for_status()
                break
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code not in (403, 502, 503, 504) or attempt == 2:
                    raise
            except httpx.TransportError:
                if attempt == 2:
                    raise
            time.sleep(8)
        result = response.json()
        if result["stored"] != len(batch):
            raise ValueError("Incomplete import")
        inserted += result["inserted"]
        phones += len(result["phone_ids"])
    print(f"stored={len(rows)} inserted={inserted} with_phone={phones}", flush=True)
    return inserted


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "run"])
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--pages", type=int, choices=range(1, 26), default=5)
    parser.add_argument("--verify-repeat", action="store_true")
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    if args.mode == "prepare":
        prepare(args.work_dir, now)
        return
    rows, state = [], {}
    with httpx.Client(headers={"User-Agent": olx.USER_AGENT, "Accept": "text/html"}, timeout=30) as public:
        collect_web(state, now, public, None, max_pages=args.pages, on_batch=rows.extend)
    print(f"pages={state['olx_pages']} jobs={len(rows)} status={state['olx_status']}", flush=True)
    if state["olx_status"] != "ok":
        raise SystemExit(1)
    token = (args.work_dir / "token").read_text().strip()
    with httpx.Client(headers={"Authorization": f"Bearer {token}"}, timeout=45, follow_redirects=False) as receiver:
        upload(receiver, rows)
        if args.verify_repeat and upload(receiver, rows):
            raise RuntimeError("Repeat import inserted new rows")


if __name__ == "__main__":
    main()

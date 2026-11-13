"""Ключи для выкладки сервера, выведенные из одного секрета: SERVER_SECRET, а если его нет,
SERVER_PASSWORD (пароль root из письма хостинга).

Workflow «Сервер» запускается на чистой машине GitHub и не может сохранить новый секрет,
поэтому ключи не хранятся, а каждый раз выводятся заново из секрета через HMAC-SHA-256:

- ключ выкладки: им workflow входит на сервер, другие способы входа после первой выкладки выключены;
- ключ сервера: его подпись workflow знает заранее, так что подменить сервер нельзя;
- ключ резервных копий: им шифруются ночные копии (печатается в stdout).

Запуск: python keys.py <папка> <IP сервера>
Пароль для другой задачи из того же секрета: python keys.py --label <метка> (печатает 40 hex-символов;
так workflow «Google Play» получает пароль ключа загрузки).
"""

from __future__ import annotations

import hashlib
import hmac
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization as s
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def derive(secret: bytes, label: str) -> bytes:
    return hmac.new(secret, label.encode(), hashlib.sha256).digest()


def write_key(folder: Path, name: str, seed: bytes) -> str:
    key = Ed25519PrivateKey.from_private_bytes(seed)
    private = key.private_bytes(s.Encoding.PEM, s.PrivateFormat.OpenSSH, s.NoEncryption())
    public = key.public_key().public_bytes(s.Encoding.OpenSSH, s.PublicFormat.OpenSSH).decode()
    path = folder / f"{name}_ed25519"
    path.write_bytes(private)
    path.chmod(0o600)
    (folder / f"{name}_ed25519.pub").write_text(f"{public} vacante-{name}\n")
    return public


def server_secret() -> bytes:
    # SERVER_SECRET — для сервера, куда первый раз входят по ключу (SERVER_SSH_KEY): из такого ключа
    # выводить нельзя, workflow убирает его с сервера, а сам ключ мог где-то засветиться
    own = os.environ.get("SERVER_SECRET", "")
    if own and len(own) < 20:
        sys.exit("SERVER_SECRET короче 20 символов: нужна длинная случайная строка")
    secret = (own or os.environ.get("SERVER_PASSWORD", "")).encode()
    if len(secret) < 8:
        sys.exit("SERVER_PASSWORD пустой или короче 8 символов")
    return secret


def main(folder: str, host: str, port: int = 22) -> None:
    secret = server_secret()
    out = Path(folder)
    out.mkdir(mode=0o700, parents=True, exist_ok=True)
    write_key(out, "deploy", derive(secret, "vacante-deploy-key-v1"))
    host_public = write_key(out, "host", derive(secret, "vacante-host-key-v1"))
    name = host if port == 22 else f"[{host}]:{port}"
    (out / "known_hosts").write_text(f"{name} {host_public}\n")
    print(derive(secret, "vacante-backup-key-v1").hex())


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--label":
        print(derive(server_secret(), sys.argv[2]).hex()[:40])
        sys.exit()
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 22)

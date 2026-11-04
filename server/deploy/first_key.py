"""Кладёт ключ первого входа из секрета SERVER_SSH_KEY в файл, исправляя то, что портится при копировании.

Переводы строк Windows, пробелы вместо переводов строк, \\n буквами, лишний текст вокруг ключа:
ключ собирается заново из текста между -----BEGIN … и -----END …. В журнал пишет только, что
пришлось поправить, сам ключ не печатает. Запуск: python first_key.py <файл>
"""

import os
import re
import sys
import textwrap
from typing import NoReturn


def fail(message: str) -> NoReturn:
    print(f"::error::{message}")
    sys.exit(1)


def main(path: str) -> None:
    raw = os.environ.get("SERVER_SSH_KEY", "")
    text = raw.replace("\r", "").replace("\\n", "\n")
    found = re.search(r"-----BEGIN ([A-Z0-9 ]+)-----(.*?)-----END \1-----", text, re.S)
    if not found:
        fail("В секрете SERVER_SSH_KEY нет строк -----BEGIN … и -----END …: нужен закрытый ключ целиком")
    kind, body = found.group(1), found.group(2)
    if ":" in body:
        # Заголовки Proc-Type и DEK-Info бывают только у ключа под паролем
        fail("Ключ в SERVER_SSH_KEY защищён паролем, нужен ключ без пароля")
    body = re.sub(r"\s+", "", body)
    width = 70 if kind == "OPENSSH PRIVATE KEY" else 64
    key = f"-----BEGIN {kind}-----\n" + "\n".join(textwrap.wrap(body, width)) + f"\n-----END {kind}-----\n"

    fixes = []
    if "\r" in raw:
        fixes.append("переводы строк Windows")
    if "\\n" in raw:
        fixes.append("\\n буквами вместо переводов строк")
    if text.strip() != found.group(0).strip():
        fixes.append("лишний текст вокруг ключа")
    if re.search(r"[ \t]", found.group(2).strip()):
        fixes.append("пробелы вместо переводов строк")
    if fixes:
        print("Ключ из SERVER_SSH_KEY собран заново: " + ", ".join(fixes))

    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(key)


if __name__ == "__main__":
    main(sys.argv[1])

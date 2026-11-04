"""Кладёт ключ первого входа из секрета SERVER_SSH_KEY в файл, исправляя то, что портится при копировании.

Ключ собирается заново из его текста, поэтому не мешают переводы строк Windows, пробелы или \\n
буквами вместо переводов строк, типографские тире и неразрывные пробелы, лишний текст вокруг ключа,
а у ключа OpenSSH и потерянные строки -----BEGIN … и -----END …. Если ключа в секрете нет, он
неполный или под паролем, пишет, что именно не так. Журнал выкладки открыт всем, поэтому ни ключ,
ни куски секрета в него не попадают: только что пришлось поправить, а при ошибке сколько в секрете
знаков и строк и какие в нём слова-метки.

Запуск: python first_key.py <файл>. python first_key.py --self-test проверяет разбор на ключах,
которые создаёт сам.
"""

import base64
import os
import re
import struct
import subprocess
import sys
import tempfile
import textwrap
from typing import NoReturn, Optional

OPENSSH = "OPENSSH PRIVATE KEY"
# Тело любого ключа OpenSSH начинается с base64 от "openssh-key-v1\0"
OPENSSH_START = "b3BlbnNzaC1rZXktdjE"
MAGIC = b"openssh-key-v1\0"

# Что подставляют вместо дефисов, пробелов и переводов строк редакторы, мессенджеры и заметки
DASHES = "‐‑‒–—―−﹘﹣－"
SPACES = "               　"
INVISIBLE = "­​‌‍⁠﻿"
BREAKS = "\u0085  "

KIND = r"((?:[A-Z0-9]+\s+)*?PRIVATE\s+KEY)"
ARMOR = re.compile(rf"-+[ \t]*BEGIN\s+{KIND}[ \t]*-+(.*?)-+[ \t]*END\s+{KIND}[ \t]*-+", re.S)
# Конец ключа, у которого потерялись дефисы: внутри base64 пробелов не бывает, так что спутать не с чем
FOOTER = re.compile(r"END\s+(?:[A-Z0-9]+\s+)*?PRIVATE\s+KEY")
PUBLIC = re.compile(r"(ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com)\s+AAAA")
BASE64 = re.compile(r"[A-Za-z0-9+/]+={0,2}")

AGAIN = "Скопируйте файл ключа целиком, от -----BEGIN до -----END, и вставьте в секрет заново"
BROKEN = f"Ключ в SERVER_SSH_KEY повреждён при копировании. {AGAIN}"
SHORT = f"Ключ в SERVER_SSH_KEY неполный: часть его потерялась при копировании. {AGAIN}"
PASSWORD = "Ключ в SERVER_SSH_KEY защищён паролем, нужен ключ без пароля"


class BadKey(Exception):
    pass


def fail(message: str) -> NoReturn:
    print(f"::error::{message}")
    sys.exit(1)


def clean(raw: str) -> tuple[str, list[str]]:
    """Возвращает текст без того, что портится при копировании, и что именно нашлось."""
    fixes = []
    text = raw
    if "\r" in text:
        fixes.append("переводы строк Windows")
        text = text.replace("\r\n", "\n").replace("\r", "\n")
    if "\\n" in text or "\\r" in text:
        fixes.append("\\n буквами вместо переводов строк")
        text = text.replace("\\r", "").replace("\\n", "\n")
    for chars, replacement, what in (
        (DASHES, "-", "типографские тире вместо дефисов"),
        (SPACES, " ", "неразрывные пробелы"),
        (INVISIBLE, "", "невидимые знаки"),
        (BREAKS, "\n", "особые переводы строк"),
    ):
        if any(c in text for c in chars):
            fixes.append(what)
            text = text.translate({ord(c): replacement for c in chars})
    return text, fixes


def openssh_body(text: str) -> Optional[str]:
    """Тело ключа OpenSSH, найденное по его началу: так ключ находится и без строк BEGIN и END."""
    start = text.find(OPENSSH_START)
    if start < 0:
        return None
    run = re.match(r"[A-Za-z0-9+/=\s]*", text[start:]).group(0)
    return FOOTER.split(run, maxsplit=1)[0]


def check_openssh(body: str) -> None:
    """Разбирает ключ OpenSSH по полям: целый ли он и без пароля ли. Иначе BadKey с объяснением."""
    if not BASE64.fullmatch(body):
        raise BadKey(BROKEN)
    if len(body) % 4:
        raise BadKey(SHORT)
    data = base64.b64decode(body)
    if not data.startswith(MAGIC):
        raise BadKey(BROKEN)
    pos = len(MAGIC)

    def take(n: int) -> bytes:
        nonlocal pos
        if pos + n > len(data):
            raise BadKey(SHORT)
        pos += n
        return data[pos - n:pos]

    def string() -> bytes:
        return take(struct.unpack(">I", take(4))[0])

    cipher = string()
    string()  # kdfname
    string()  # kdfoptions
    for _ in range(struct.unpack(">I", take(4))[0]):
        string()  # открытые ключи
    private = string()
    if cipher != b"none":
        raise BadKey(PASSWORD)
    # У ключа без пароля закрытая часть начинается с двух одинаковых проверочных чисел
    if pos != len(data) or len(private) < 8 or private[:4] != private[4:8]:
        raise BadKey(BROKEN)


def describe(raw: str, text: str) -> str:
    """Что лежит в секрете вместо ключа, без самого содержимого."""
    if "PuTTY-User-Key-File" in text:
        return ("В SERVER_SSH_KEY ключ PuTTY (.ppk), а нужен ключ OpenSSH: откройте ключ в PuTTYgen, "
                "выберите Conversions → Export OpenSSH key и вставьте в секрет содержимое нового файла")
    if PUBLIC.search(text) or re.search(r"BEGIN\s+(?:[A-Z0-9]+\s+)*?PUBLIC\s+KEY", text):
        return ("В SERVER_SSH_KEY открытый ключ, а нужен закрытый: файл с тем же именем, но без .pub. "
                "Он начинается со строки -----BEGIN OPENSSH PRIVATE KEY-----")
    marks = [w for w in ("BEGIN", "END", "PRIVATE KEY", "OPENSSH") if w in text]
    found = "есть слова " + ", ".join(marks) if marks else "слов BEGIN, END и PRIVATE KEY нет"
    other = []
    if re.search(r"[А-Яа-яЁё]", text):
        other.append("есть русские буквы")
    if re.search(r"[^\x00-\x7fА-Яа-яЁё]", text):
        other.append("есть знаки не латиницей")
    lines = sum(1 for line in text.split("\n") if line.strip())
    facts = ", ".join([f"знаков: {len(raw.strip())}", f"строк: {lines}", found] + other)
    return (f"В секрете SERVER_SSH_KEY нет закрытого ключа SSH ({facts}). Нужен файл ключа целиком, "
            f"от -----BEGIN OPENSSH PRIVATE KEY----- до -----END OPENSSH PRIVATE KEY-----")


def build(raw: str) -> tuple[str, list[str]]:
    """Ключ в обычном виде и что пришлось поправить. BadKey, если ключа нет или он негодный."""
    text, fixes = clean(raw)
    kind = body = None
    m = ARMOR.search(text)
    if m and " ".join(m.group(1).split()) == " ".join(m.group(3).split()):
        kind, body = " ".join(m.group(1).split()), m.group(2)
        if text.strip() != m.group(0).strip():
            fixes.append("лишний текст вокруг ключа")
        if re.search(r"\S[ \t]+\S", body):
            fixes.append("пробелы вместо переводов строк")
    else:
        body = openssh_body(text)
        if body is not None:
            kind = OPENSSH
            fixes.append("потерялись или испорчены строки -----BEGIN и -----END")
    if kind is None:
        raise BadKey(describe(raw, text))
    if ":" in body or kind == "ENCRYPTED PRIVATE KEY":
        # Заголовки Proc-Type и DEK-Info бывают только у ключа под паролем
        raise BadKey(PASSWORD)
    body = re.sub(r"\s+", "", body)
    if kind == OPENSSH:
        check_openssh(body)
    elif not BASE64.fullmatch(body) or len(body) % 4:
        raise BadKey(BROKEN)
    width = 70 if kind == OPENSSH else 64
    key = f"-----BEGIN {kind}-----\n" + "\n".join(textwrap.wrap(body, width)) + f"\n-----END {kind}-----\n"
    return key, fixes


def main(path: str) -> None:
    try:
        key, fixes = build(os.environ.get("SERVER_SSH_KEY", ""))
    except BadKey as e:
        fail(str(e))
    if fixes:
        print("Ключ из SERVER_SSH_KEY собран заново: " + ", ".join(fixes))
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(key)


def self_test() -> None:
    """Портит свежие ключи так, как их портит копирование: каждый вариант должен собраться в
    исходный ключ, а негодный секрет дать свою ошибку. Ключи создаются здесь же и не печатаются."""
    with tempfile.TemporaryDirectory() as tmp:

        def keygen(name: str, *args: str) -> str:
            path = os.path.join(tmp, name)
            subprocess.run(["ssh-keygen", "-q", "-C", "test", "-f", path, *args], check=True)
            with open(path) as f:
                return f.read()

        key = keygen("ed", "-t", "ed25519", "-N", "")
        rsa = keygen("rsa", "-t", "rsa", "-b", "2048", "-m", "PEM", "-N", "")
        locked = keygen("locked", "-t", "ed25519", "-N", "test-password")
        with open(os.path.join(tmp, "ed.pub")) as f:
            pub = f.read()
        lines = key.strip().split("\n")
        body = lines[1:-1]
        spoiled = lines[:2] + [lines[2][:10] + "*" + lines[2][11:]] + lines[3:]
        good = {
            "как есть": key,
            "переводы строк Windows": key.replace("\n", "\r\n"),
            "одной строкой через пробелы": " ".join(lines),
            "одной строкой без пробелов": "".join(lines),
            "\\n буквами": "\\n".join(lines),
            "с текстом вокруг": "Ключ:\n" + key + "\nвот",
            "с отступами": "\n".join("    " + line for line in lines),
            "типографские тире": key.replace("--", "—"),
            "неразрывные пробелы": key.replace(" ", " "),
            "невидимые знаки": "﻿" + key.replace("\n", "​\n"),
            "без BEGIN и END": "\n".join(body),
            "без BEGIN": "\n".join(lines[1:]),
            "без END": "\n".join(lines[:-1]),
            "без дефисов": "\n".join(line.strip("-") for line in lines),
            "без дефисов одной строкой": " ".join(line.strip("-") for line in lines),
        }
        for name, text in good.items():
            got, _ = build(text)
            assert got == key, f"не собрался ключ: {name}"
        assert build(" ".join(rsa.strip().split("\n")))[0] == rsa, "не собрался ключ RSA одной строкой"
        bad = {
            "открытый ключ": (pub, "открытый ключ"),
            "неполный": ("\n".join(lines[:3] + lines[-1:]), "неполный"),
            "без последней строки тела": ("\n".join(lines[:-2] + lines[-1:]), "неполный"),
            "испорченная буква": ("\n".join(spoiled), "повреждён"),
            "под паролем": (locked, "паролем"),
            "пустой": ("", "нет закрытого ключа"),
            "случайная строка": ("Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy", "знаков: 30, строк: 1"),
            "ключ PuTTY": ("PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n", "PuTTY"),
        }
        for name, (text, expected) in bad.items():
            try:
                build(text)
            except BadKey as e:
                assert expected in str(e), f"{name}: не та ошибка: {e}"
                assert OPENSSH_START not in str(e), f"{name}: в ошибку попал ключ"
            else:
                raise AssertionError(f"{name}: негодный ключ принят")
    print(f"first_key.py: {len(good) + 1} вариантов ключа собраны, {len(bad)} негодных секретов отклонены")


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    else:
        main(sys.argv[1])

#!/usr/bin/env bash
# Ночная резервная копия Vacante (vacante-backup.timer): база SQLite и кружки одним
# зашифрованным архивом. Копии лежат на этом же сервере 7 дней, каждая новая сразу
# проверяется восстановлением во временную папку.
set -euo pipefail
DATA=${DATA_DIR:-/var/lib/vacante}
DEST=${BACKUP_DIR:-/var/backups/vacante}
KEEP_DAYS=${KEEP_DAYS:-7}
: "${BACKUP_KEY:?нет BACKUP_KEY в /etc/vacante/env}"
enc=(-aes-256-cbc -pbkdf2 -iter 200000 -md sha256)

if [ ! -f "$DATA/vacante.db" ]; then
  echo "Базы ещё нет, копировать нечего"
  exit 0
fi

umask 077
mkdir -p "$DEST"
work=$(mktemp -d)
check=$(mktemp -d)
trap 'rm -rf "$work" "$check"' EXIT

# .backup делает целостный снимок, даже когда сервер в это время пишет в базу
sqlite3 "$DATA/vacante.db" ".backup '$work/vacante.db'"
[ "$(sqlite3 "$work/vacante.db" 'PRAGMA integrity_check')" = ok ]
mkdir -p "$DATA/videos"

name="vacante-$(date -u +%Y-%m-%dT%H%M%SZ).tar.gz.enc"
tar -C "$work" -cf - vacante.db -C "$DATA" videos | gzip -6 \
  | openssl enc "${enc[@]}" -salt -pass env:BACKUP_KEY -out "$DEST/$name.part"
mv "$DEST/$name.part" "$DEST/$name"

# Проверка: копия расшифровывается, распаковывается, и база в ней целая
openssl enc -d "${enc[@]}" -pass env:BACKUP_KEY -in "$DEST/$name" | tar -xzf - -C "$check"
[ "$(sqlite3 "$check/vacante.db" 'PRAGMA integrity_check')" = ok ]

find "$DEST" -maxdepth 1 -name 'vacante-*.tar.gz.enc' -mmin +$((KEEP_DAYS * 24 * 60)) -delete
echo "Копия $name ($(du -h "$DEST/$name" | cut -f1)) записана и проверена"

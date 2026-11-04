#!/usr/bin/env bash
# Восстановление Vacante из резервной копии, вручную под root:
#   vacante-restore /var/backups/vacante/vacante-2026-11-05T223000Z.tar.gz.enc
# Текущие данные не удаляются, а переезжают в /var/lib/vacante.before-restore-<время>.
set -euo pipefail
file=${1:?укажите файл копии из /var/backups/vacante}
set -a
# shellcheck disable=SC1091
. /etc/vacante/env
set +a
: "${BACKUP_KEY:?нет BACKUP_KEY в /etc/vacante/env}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -pass env:BACKUP_KEY -in "$file" | tar -xzf - -C "$work"
[ "$(sqlite3 "$work/vacante.db" 'PRAGMA integrity_check')" = ok ]

systemctl stop vacante-api
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mv /var/lib/vacante "/var/lib/vacante.before-restore-$stamp"
install -d -o vacante -g vacante -m 700 /var/lib/vacante
cp -a "$work/vacante.db" "$work/videos" /var/lib/vacante/
chown -R vacante:vacante /var/lib/vacante
systemctl start vacante-api
echo "Восстановлено из $file. Прежние данные: /var/lib/vacante.before-restore-$stamp"

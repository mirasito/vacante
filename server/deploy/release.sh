#!/usr/bin/env bash
# Включает новую версию сервера (запускает workflow «Сервер»):
#   release.sh <коммит> <архив с server/ и config/>
# Если новая версия не ответила на /health за 30 секунд, возвращается прошлая.
set -euo pipefail
sha=${1:?коммит}
archive=${2:?архив}
if [[ ! $sha =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "Странный номер коммита: $sha" >&2
  exit 1
fi
root=/opt/vacante
dir=$root/releases/$sha

rm -rf "$dir.new"
mkdir -p "$dir.new"
tar -xzf "$archive" -C "$dir.new"
echo "$sha" > "$dir.new/VERSION"
chown -R root:root "$dir.new"
chmod -R go-w "$dir.new"
rm -rf "$dir"
mv "$dir.new" "$dir"
rm -f "$archive"

# Снимок базы перед миграциями новой версии; пишет пользователь сервера, чтобы не сбить права
if [ -f /var/lib/vacante/vacante.db ]; then
  runuser -u vacante -- sqlite3 /var/lib/vacante/vacante.db ".backup '/var/backups/vacante/pre-deploy.db'"
fi

prev=$(readlink -f "$root/current" 2>/dev/null || true)
ln -sfn "$dir" "$root/current"
systemctl restart vacante-api

ok=
for _ in $(seq 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:8080/health >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done
if [ -z "$ok" ]; then
  echo "Версия $sha не запустилась:" >&2
  journalctl -u vacante-api -n 40 --no-pager >&2 || true
  if [ -n "$prev" ] && [ -d "$prev" ] && [ "$prev" != "$dir" ]; then
    ln -sfn "$prev" "$root/current"
    systemctl restart vacante-api
    echo "Вернул прошлую версию $(basename "$prev")" >&2
  fi
  exit 1
fi

# Храним пять последних версий
find "$root/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +6 | cut -d' ' -f2- \
  | while read -r old; do [ "$old" != "$dir" ] && rm -rf "$old"; done
echo "Работает версия $sha"

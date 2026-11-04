#!/usr/bin/env bash
# Настройка сервера Vacante: запускает workflow «Сервер» под root при каждой выкладке.
# Повторный запуск ничего не ломает: ставит недостающее и обновляет настройки из репозитория.
# Подходит для Ubuntu 22.04/24.04 и Debian 12.
set -euo pipefail
# C.UTF-8 есть в любой Ubuntu и Debian: так apt и perl не ругаются, даже если язык системы сломан
export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8

here=$(cd "$(dirname "$0")" && pwd)
NODE_MAJOR=24
SSH_PORT=${SSH_PORT:-22}

log() { printf '\n== %s\n' "$*"; }

log "Язык системы"
# Если в /etc/default/locale названа локаль, которой на сервере нет (так было на сервере после
# другого проекта), программы на каждом шагу ругаются. Тогда ставим обычную для облачной Ubuntu C.UTF-8
broken=$(env -i bash -c 'set -a; . /etc/default/locale 2>/dev/null; locale 2>&1 >/dev/null; true')
if [ -n "$broken" ]; then
  printf 'LANG=C.UTF-8\n' > /etc/default/locale
  echo "Была локаль, которой на сервере нет, теперь C.UTF-8"
else
  echo "В порядке"
fi

log "Пакеты и автоматические обновления безопасности"
apt-get update -q
apt-get install -y -q --no-install-recommends \
  ca-certificates curl gnupg openssl sqlite3 xz-utils tar gzip \
  ufw fail2ban python3-systemd unattended-upgrades
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

log "Caddy: принимает HTTPS и сам выпускает и продлевает сертификаты"
if ! command -v caddy >/dev/null; then
  # Команды из https://caddyserver.com/docs/install (Debian, Ubuntu)
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

log "Node.js $NODE_MAJOR с nodejs.org, с проверкой контрольной суммы"
case "$(dpkg --print-architecture)" in
  amd64) arch=x64 ;;
  arm64) arch=arm64 ;;
  *) echo "Неизвестная архитектура $(dpkg --print-architecture)" >&2; exit 1 ;;
esac
base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
sums=$(curl -fsSL "$base/SHASUMS256.txt")
file=$(printf '%s\n' "$sums" | awk -v want="-linux-$arch.tar.xz" 'substr($2, length($2) - length(want) + 1) == want { print $2; exit }')
version=${file#node-}
version=${version%"-linux-$arch.tar.xz"}
if [ -z "$file" ]; then
  echo "Не нашёл Node.js $NODE_MAJOR для linux-$arch" >&2
  exit 1
fi
if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "$version" ]; then
  tmp=$(mktemp -d)
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && printf '%s\n' "$sums" | grep -F "  $file" | sha256sum -c --quiet -)
  rm -rf /opt/node.new
  mkdir -p /opt/node.new
  tar -xJf "$tmp/$file" -C /opt/node.new --strip-components=1
  rm -rf /opt/node
  mv /opt/node.new /opt/node
  ln -sfn /opt/node/bin/node /usr/local/bin/node
  rm -rf "$tmp"
fi
node --version

log "Пользователь и папки"
id vacante >/dev/null 2>&1 || useradd --system --home-dir /var/lib/vacante --shell /usr/sbin/nologin vacante
install -d -o vacante -g vacante -m 700 /var/lib/vacante /var/lib/vacante/videos /var/backups/vacante
install -d -m 755 /opt/vacante /opt/vacante/releases
install -d -m 700 /etc/vacante
install -m 755 "$here/backup.sh" /usr/local/sbin/vacante-backup
install -m 755 "$here/restore.sh" /usr/local/sbin/vacante-restore

log "Службы systemd и Caddy"
install -m 644 "$here/vacante-api.service" /etc/systemd/system/vacante-api.service
install -m 644 "$here/vacante-backup.service" /etc/systemd/system/vacante-backup.service
install -m 644 "$here/vacante-backup.timer" /etc/systemd/system/vacante-backup.timer
install -m 644 "$here/Caddyfile" /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl daemon-reload
systemctl enable vacante-api.service vacante-backup.timer caddy.service
systemctl start vacante-backup.timer
# Перечитать Caddyfile; заодно Caddy заново пробует выпустить сертификаты, если DNS только что появился
systemctl reload caddy || systemctl restart caddy

log "Брандмауэр: открыты только SSH, HTTP и HTTPS"
if ufw allow "$SSH_PORT/tcp" >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null \
  && ufw --force enable >/dev/null; then
  ufw status | head -n 1
else
  # Так бывает на контейнерных VPS без iptables; сервер API всё равно слушает только 127.0.0.1
  echo "::warning::Брандмауэр ufw на этом сервере не включается"
fi

log "fail2ban: блокирует подбор входа по SSH"
cat > /etc/fail2ban/jail.d/vacante.conf <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable fail2ban >/dev/null
systemctl restart fail2ban

log "Подкачка 1 ГБ на случай нехватки памяти"
if ! swapon --show --noheadings | grep -q .; then
  if fallocate -l 1G /swapfile 2>/dev/null && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else
    rm -f /swapfile
    echo "Подкачку включить нельзя (так бывает на контейнерных VPS), работаем без неё"
  fi
fi

log "Готово"

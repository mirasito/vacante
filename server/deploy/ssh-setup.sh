#!/usr/bin/env bash
# Первая выкладка: на сервер входят только по ключу выкладки, ключ сервера закреплён, пароли выключены.
# Запуск от root: bash ssh-setup.sh <папка>, в папке deploy_ed25519.pub, host_ed25519, host_ed25519.pub
# и 01-vacante.conf. Если новые настройки SSH не проходят проверку, возвращает прежние.
set -euo pipefail

d=$1
umask 077
mkdir -p /root/.ssh
touch /root/.ssh/authorized_keys
key=$(cat "$d/deploy_ed25519.pub")
grep -qxF "$key" /root/.ssh/authorized_keys || printf '%s\n' "$key" >> /root/.ssh/authorized_keys

old=$(mktemp -d)
cp -a /etc/ssh/ssh_host_ed25519_key "$old/key" 2>/dev/null || true
cp -a /etc/ssh/ssh_host_ed25519_key.pub "$old/key.pub" 2>/dev/null || true
install -m 600 "$d/host_ed25519" /etc/ssh/ssh_host_ed25519_key
install -m 644 "$d/host_ed25519.pub" /etc/ssh/ssh_host_ed25519_key.pub
install -m 644 "$d/01-vacante.conf" /etc/ssh/sshd_config.d/01-vacante.conf
mkdir -p /run/sshd
if ! sshd -t; then
  rm -f /etc/ssh/sshd_config.d/01-vacante.conf
  if [ -f "$old/key" ]; then
    cp -a "$old/key" /etc/ssh/ssh_host_ed25519_key
    cp -a "$old/key.pub" /etc/ssh/ssh_host_ed25519_key.pub
  fi
  rm -rf "$old"
  echo "Новые настройки SSH не прошли проверку, вернул прежние" >&2
  exit 1
fi
rm -rf "$old"
systemctl restart ssh 2>/dev/null || systemctl restart sshd

#!/usr/bin/env bash
# Разовая очистка сервера перед первой установкой Vacante, когда сервер раньше работал под другой проект.
# Оставляет систему: пакеты образа Ubuntu для облака, ядро и загрузчик, SSH, сеть, время, диски, cloud-init
# и агенты Yandex Cloud. Удаляет остальное: службы, контейнеры, программы и их данные, других пользователей,
# пароли, ключи SSH (у root остаётся только ключ выкладки), задания cron, логи. Потом обновляет систему.
# Отдельные диски не трогает, только сообщает о них. Перезагружает сервер workflow «Сервер».
# Запуск от root: bash wipe.sh <пользователь первого входа> <тип ключа выкладки> <ключ выкладки>
# WIPE_DRY=1 только печатает, что удалил бы, и ничего не меняет.
# Журнал Actions публичный, поэтому туда идут только количества, подробности в /var/log/vacante-wipe.log.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 LC_ALL=C

user=$1
key="$2 $3"
dry=${WIPE_DRY:-}
log=/var/log/vacante-wipe.log
step="подготовка"

exec 3>&1
[ -n "$dry" ] || exec >>"$log" 2>&1
say() { printf '%s\n' "$*" >&3; }
fail() {
  say "::error::$*"
  exit 1
}
# В пробном запуске печатает команду, иначе выполняет
run() {
  if [ -n "$dry" ]; then printf '  %s\n' "$*"; else "$@"; fi
}

[ "$(id -u)" = 0 ] || fail "Очистку запускают от root"
[[ $user =~ ^[a-z_][a-z0-9_-]*$ ]] || fail "Неверное имя пользователя: $user"
if [ -e /etc/vacante ]; then
  say "На сервере уже стоит Vacante, очистку не делаю"
  exit 0
fi
# shellcheck source=/dev/null
. /etc/os-release
case "${ID:-}:${VERSION_ID:-}" in
  ubuntu:22.04 | ubuntu:24.04) ;;
  *) fail "Очистка умеет только Ubuntu 22.04 и 24.04, а на сервере ${PRETTY_NAME:-другая система}. Пересоздайте ВМ с Ubuntu 24.04" ;;
esac
if ! grep -qF "$key" /root/.ssh/authorized_keys 2>/dev/null; then
  [ -n "$dry" ] || fail "У root нет ключа выкладки, очистку не начинаю"
  say "Пробный запуск: у root нет ключа выкладки, на сервере очистка тут остановилась бы"
fi

work=$(mktemp -d /run/vacante-wipe.XXXXXX)
finish() {
  local rc=$?
  rm -rf "$work"
  if [ "$rc" != 0 ] && [ -z "$dry" ]; then
    say "::error::Очистка остановилась на шаге «$step», код $rc. Конец журнала:"
    # Пароли в адресах источников пакетов не печатаем
    tail -n 12 "$log" | sed -E 's#(://)[^/@ ]+@#\1***@#g' >&3
  fi
}
trap finish EXIT

# Пакеты, которые остаются, даже если их нет в образе Ubuntu: без них сервер может не загрузиться,
# потерять сеть, время, диски или вход
keep_pkg='^(linux-|grub|shim|mokutil|efibootmgr|secureboot|openssh-|ssh$|cloud-|netplan|ifupdown|isc-dhcp|dhcpcd|resolvconf|network-manager|networkd|iproute|netbase|iputils|systemd|udev|dbus|snapd$|ubuntu-|language-pack|locales|apt|dpkg|debconf|sudo|cron|unscd|nscd|libpam|libnss|chrony|ntp|openntpd|lvm2|mdadm|cryptsetup|multipath|xfsprogs|btrfs-progs|e2fsprogs|dosfstools|parted|gdisk|fdisk|qemu-guest-agent|open-vm-tools|hyperv|amd64-microcode|intel-microcode|irqbalance|acpid|haveged|rng-tools|zram|ca-certificates|tzdata|initramfs|busybox|kmod)|oslogin|yandex|^yc-'
# Файлы агентов Yandex Cloud (OS Login и другие) не трогаем, где бы они ни лежали
keep_path='oslogin|yandex|/yc-'
# Каталоги корня, которые есть в любой системе
std_root='^/(bin|boot|cdrom|dev|etc|home|lib|lib32|lib64|libx32|lost\+found|media|mnt|opt|proc|root|run|sbin|snap|srv|sys|tmp|usr|var|swap\.img|swapfile|[a-z0-9]+\.usr-is-merged)$'

# Это не удаляется никогда, даже если сюда приведёт ошибка в списках выше
never='^/(etc|usr|var|boot|root|home)/?$|^/etc/(ssh|netplan|cloud|pam\.d|security|systemd/network|network)(/|$)|^/var/lib/(dpkg|apt|cloud|systemd|snapd)(/|$)|^/root/\.ssh(/|$)|^/usr/(bin|sbin|lib|lib64|libexec|share|include)/?$'

lib_merged=
[ -L /lib ] && lib_merged=1
# dpkg записывает пути как в пакете, а /lib, /bin и /sbin давно ссылки на /usr: сравниваем по /usr
norm() {
  if [ -n "$lib_merged" ]; then sed -E 's#^/(bin|sbin|lib|lib32|lib64|libx32)(/|$)#/usr/\1\2#'; else cat; fi
}
# Пути из пакетов, которые остаются (в пробном запуске без тех, что удалились бы)
build_index() {
  find /var/lib/dpkg/info -maxdepth 1 -name '*.list' -printf '%f\n' \
    | awk 'NR == FNR { gone[$1]; next } { n = $0; sub(/\.list$/, "", n); sub(/:.*/, "", n); if (!(n in gone)) print "/var/lib/dpkg/info/" $0 }' "$work/removing" - \
    | tr '\n' '\0' | xargs -0 -r cat | norm | sort -u > "$work/owned"
}
owned() { grep -qxF -- "$(norm <<< "$1")" "$work/owned"; }
# Есть ли под путём файлы из пакетов
owned_below() { awk -v p="$(norm <<< "$1")/" 'index($0, p) == 1 { found = 1; exit } END { exit !found }' "$work/owned"; }
unowned() { norm | sort -u | comm -23 - "$work/owned" | { grep -Eiv "$keep_path" || true; }; }
has_mount_below() { findmnt -rn -o TARGET | awk -v p="$1/" 'index($0, p) == 1 { found = 1 } END { exit !found }'; }

# Список на удаление: $work/files. Каталог из пакетов не удаляет, а чистит внутри
clean_tree() {
  local e
  while IFS= read -r e; do
    if grep -Eiq "$keep_path" <<< "$e" || mountpoint -q -- "$e"; then continue; fi
    if owned "$e" || owned_below "$e" || has_mount_below "$e"; then
      if [ -d "$e" ] && [ ! -L "$e" ]; then clean_tree "$e"; fi
      continue
    fi
    printf '%s\n' "$e" >> "$work/files"
  done < <(find "$1" -mindepth 1 -maxdepth 1 2>/dev/null | sort)
}
# Программы, у которых sshd спрашивает ключи (так работает OS Login)
sshd_cmds=$(sshd -T 2>/dev/null | awk '($1 == "authorizedkeyscommand" || $1 == "authorizedprincipalscommand") && $2 ~ /^\// { print $2 }' || true)
{
  printf '%s\n' "$sshd_cmds"
  grep -hoE '(^|[[:space:]])/[^[:space:]]+\.so' /etc/pam.d/* 2>/dev/null | tr -d '[:blank:]' || true
} | sed '/^$/d' | sort -u > "$work/vital"
vital() { awk -v p="$1" '$0 == p || index($0, p "/") == 1 { found = 1 } END { exit !found }' "$work/vital"; }
removed=0
remove_files() {
  [ -s "$work/files" ] || return 0
  local p
  while IFS= read -r p; do
    case "$p" in /*/*) ;; /*) [[ $p =~ $std_root ]] && continue ;; *) continue ;; esac
    [[ $p =~ $never ]] && continue
    vital "$p" && continue
    if [ -n "$dry" ]; then
      printf '  удалю %s\n' "$p"
    elif ! mountpoint -q -- "$p"; then
      rm -rf --one-file-system -- "$p" || true
    fi
    removed=$((removed + 1))
  done < "$work/files"
  : > "$work/files"
}
lines() { if [ -s "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }
show() { [ -z "$dry" ] || { echo "$1:"; sed 's/^/  /' "$2"; }; }

step="список пакетов образа Ubuntu"
arch=$(dpkg --print-architecture)
manifest="https://cloud-images.ubuntu.com/releases/$VERSION_CODENAME/release/ubuntu-$VERSION_ID-server-cloudimg-$arch.manifest"
curl -fsSL --retry 3 --max-time 120 "$manifest" -o "$work/manifest" || fail "Не скачался список пакетов образа Ubuntu: $manifest"
cut -f1 "$work/manifest" | sed 's/:.*//' | sort -u > "$work/base"
[ "$(lines "$work/base")" -gt 300 ] || fail "Список пакетов образа Ubuntu слишком короткий: $manifest"

step="выбор пакетов"
dpkg-query -W -f='${db:Status-Abbrev}\t${Package}\t${Essential}\t${Priority}\n' > "$work/pkgs"
awk -F'\t' '$1 ~ /^.i/ { print $2 }' "$work/pkgs" | sort -u > "$work/installed"
awk -F'\t' '$1 ~ /^.i/ && ($3 == "yes" || $4 == "required" || $4 == "important") { print $2 }' "$work/pkgs" | sort -u > "$work/essential"
awk -F'\t' '$1 ~ /^rc/ { print $2 }' "$work/pkgs" | sort -u > "$work/leftover"
apt-mark showmanual | sed 's/:.*//' | sort -u > "$work/manual"
# Пакеты с модулями входа (PAM, NSS) и с программой ключей для sshd (так работает OS Login): без них
# sshd может перестать пускать даже root по ключу
{
  grep -lE '/security/pam_[^/]*\.so$|/libnss_[^/]*\.so' /var/lib/dpkg/info/*.list || true
  for c in $sshd_cmds; do grep -lxF -- "$c" /var/lib/dpkg/info/*.list || true; done
} | sed -E 's#.*/##; s#\.list$##; s#:.*##' | sort -u > "$work/login"
sort -u "$work/base" "$work/essential" "$work/login" > "$work/keep"
must_stay() { awk -v re="$keep_pkg" 'NR == FNR { k[$1]; next } ($1 in k) || $1 ~ re' "$work/keep" -; }
# Пакеты, которые поставили руками поверх образа; их зависимости потом уберёт autoremove
comm -12 "$work/installed" "$work/manual" | comm -23 - "$work/keep" | { grep -Ev "$keep_pkg" || true; } > "$work/extra"
removes() {
  local out
  out=$(apt-get -s purge --allow-change-held-packages "$@" 2>&1) || return 1
  awk '$1 == "Purg" || $1 == "Remv" { print $2 }' <<< "$out" | sed 's/:.*//' | sort -u
}
# apt удаляет и то, что зависит от удаляемого: проверяем, что системные пакеты при этом остаются
safe() {
  local r
  r=$(removes "$@") || return 1
  [ -z "$(must_stay <<< "$r")" ]
}
mapfile -t extra < "$work/extra"
if [ "${#extra[@]}" -gt 0 ] && ! safe "${extra[@]}"; then
  export work keep_pkg
  export -f removes safe must_stay
  # shellcheck disable=SC2016 # $1 раскрывает bash внутри xargs
  printf '%s\n' "${extra[@]}" | xargs -r -P 4 -n 1 bash -c 'if safe "$1"; then printf "%s\n" "$1"; fi' _ | sort > "$work/extra.ok"
  mapfile -t extra < "$work/extra.ok"
  if [ "${#extra[@]}" -gt 0 ] && ! safe "${extra[@]}"; then extra=(); fi
fi
kept_pkgs=$(($(lines "$work/extra") - ${#extra[@]}))
: > "$work/removing"
if [ "${#extra[@]}" -gt 0 ]; then removes "${extra[@]}" > "$work/removing"; fi
cat "$work/leftover" >> "$work/removing"
printf '%s\n' "${extra[@]}" | sed '/^$/d' > "$work/extra"
show "Пакеты к удалению" "$work/removing"

step="снапы"
: > "$work/snaps"
if command -v snap >/dev/null && snap list > "$work/snap-list" 2>/dev/null; then
  awk 'NR > 1 { print $1 }' "$work/snap-list" | { grep -Evx 'snapd|core|core[0-9]+|bare|lxd' || true; } > "$work/snaps"
fi
show "Снапы к удалению" "$work/snaps"

step="службы"
build_index
unit_dirs=()
for d in /etc/systemd/system /usr/lib/systemd/system /usr/local/lib/systemd/system /lib/systemd/system /etc/systemd/user /usr/lib/systemd/user; do
  if [ -d "$d" ] && { [ -z "$lib_merged" ] || [[ $d != /lib/* ]]; }; then unit_dirs+=("$d"); fi
done
[ "${#unit_dirs[@]}" -gt 0 ] || fail "Не нашёл папок systemd"
find "${unit_dirs[@]}" -maxdepth 1 -type f \( -name '*.service' -o -name '*.timer' -o -name '*.socket' -o -name '*.path' \) \
  ! -name 'snap.*' ! -name 'snap-*' | unowned > "$work/units"
# Службы, подключённые ссылкой на файл вне системных папок (systemctl link)
while IFS= read -r l; do
  t=$(readlink -f -- "$l" || true)
  case "$t" in "" | /dev/null | /etc/systemd/* | /usr/lib/systemd/* | /lib/systemd/*) continue ;; esac
  grep -Eiq "$keep_path" <<< "$l$t" || printf '%s\n' "$l" >> "$work/units"
done < <(find /etc/systemd/system -maxdepth 1 -type l)
show "Службы к удалению" "$work/units"

step="пользователи"
uid_min=$(awk '$1 == "UID_MIN" { print $2 }' /etc/login.defs)
uid_max=$(awk '$1 == "UID_MAX" { print $2 }' /etc/login.defs)
awk -F: -v min="${uid_min:-1000}" -v max="${uid_max:-60000}" '$3 >= min && $3 <= max { print $1 }' /etc/passwd > "$work/people"
grep -vxF "$user" "$work/people" > "$work/users" || true
show "Пользователи к удалению" "$work/users"

# Дальше сервер меняется
step="остановка служб"
if [ -z "$dry" ]; then
  systemctl stop apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service || true
fi
while IFS= read -r f; do
  u=${f##*/}
  case "$f" in /etc/systemd/user/* | /usr/lib/systemd/user/*) continue ;; esac
  case "$u" in *@.*) run timeout 120 systemctl stop "${u%%@*}@*.${u##*.}" || true ;; esac
  run timeout 120 systemctl disable --now "$u" || run systemctl kill -s KILL "$u" || true
done < "$work/units"
if [ -z "$dry" ] && systemctl list-unit-files docker.service containerd.service >/dev/null 2>&1; then
  timeout 120 systemctl stop docker.socket docker.service containerd.service || true
fi
while IFS= read -r u; do
  run pkill -KILL -u "$u" || true
done < "$work/people"
run rm -f /var/lib/systemd/linger/*

step="снапы"
for _ in 1 2; do
  while IFS= read -r s; do
    run snap remove --purge "$s" || true
  done < "$work/snaps"
done

step="пакеты"
apt=(apt-get -y -q -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
holds=$(apt-mark showhold | wc -l)
if [ "$holds" -gt 0 ]; then
  apt-mark showhold | tr '\n' '\0' | { if [ -n "$dry" ]; then tr '\0' ' '; echo; else xargs -0 apt-mark unhold; fi; }
fi
# Пакеты образа помечаем поставленными руками, чтобы autoremove их не тронул
{
  comm -12 "$work/installed" "$work/keep"
  grep -E "$keep_pkg" "$work/installed" || true
} | sort -u | { grep -Ev '^linux-.*[0-9]+\.[0-9]+\.[0-9]+-[0-9]+' || true; } > "$work/mark"
[ -n "$dry" ] || xargs -r apt-mark manual < "$work/mark" >/dev/null
if [ -s "$work/extra" ]; then
  mapfile -t extra < "$work/extra"
  if [ -z "$dry" ] && ! "${apt[@]}" purge --allow-change-held-packages "${extra[@]}"; then
    dpkg --configure -a || true
    "${apt[@]}" purge --allow-change-held-packages "${extra[@]}"
  fi
fi
if [ -s "$work/leftover" ] && [ -z "$dry" ]; then xargs -r dpkg --purge < "$work/leftover" || true; fi
[ -n "$dry" ] || "${apt[@]}" autoremove --purge

step="файлы"
[ -n "$dry" ] || { : > "$work/removing"; build_index; }
# Файлы служб, их ссылки и настройки
while IFS= read -r f; do
  printf '%s\n' "$f"
  [ ! -d "/etc/systemd/system/${f##*/}.d" ] || printf '%s\n' "/etc/systemd/system/${f##*/}.d"
done < "$work/units" >> "$work/files"
remove_files
units_removed=$(lines "$work/units")
if [ -z "$dry" ]; then
  find /etc/systemd/system /etc/systemd/user -xtype l -delete 2>/dev/null || true
  systemctl daemon-reload
fi

removed=0
# Программы и данные вне пакетов: /opt, /srv, /usr/local, лишнее в корне, данные служб
clean_tree /opt
clean_tree /srv
clean_tree /usr/local
swaps=$(swapon --show=NAME --noheadings 2>/dev/null || true)
while IFS= read -r e; do
  if [[ $e =~ $std_root ]] || mountpoint -q -- "$e" || grep -qxF -- "$e" <<< "$swaps"; then continue; fi
  owned "$e" || owned_below "$e" || has_mount_below "$e" || grep -Eiq "$keep_path" <<< "$e" || printf '%s\n' "$e" >> "$work/files"
done < <(find / -mindepth 1 -maxdepth 1 | sort)
clean_tree /mnt
clean_tree /media
for p in /var/lib/docker /var/lib/containerd /var/lib/dockershim /var/lib/kubelet /var/lib/rancher /var/lib/k0s \
  /var/lib/postgresql /var/lib/mysql /var/lib/mysql-files /var/lib/mysql-keyring /var/lib/mongodb /var/lib/redis \
  /var/lib/rabbitmq /var/lib/elasticsearch /var/lib/opensearch /var/lib/clickhouse /var/lib/influxdb /var/lib/grafana \
  /var/lib/prometheus /var/lib/minio /var/lib/jenkins /var/lib/gitlab-runner /var/lib/kafka /var/lib/zookeeper \
  /var/lib/cassandra /var/lib/neo4j /var/lib/couchdb /var/lib/tor /var/lib/nginx /var/lib/php /var/lib/caddy \
  /var/lib/fail2ban /var/lib/letsencrypt /var/lib/pm2 /var/www /var/cache/nginx /var/spool/squid /usr/lib/node_modules \
  /etc/docker /etc/containerd /etc/rancher /etc/cni /opt/cni /etc/supervisor /etc/nginx /etc/apache2 /etc/php \
  /etc/mysql /etc/postgresql /etc/postgresql-common /etc/redis /etc/mongod.conf /etc/rabbitmq /etc/elasticsearch \
  /etc/grafana /etc/prometheus /etc/caddy /etc/tor /etc/squid /etc/privoxy /etc/openvpn /etc/wireguard \
  /etc/letsencrypt /etc/clickhouse-server /etc/clickhouse-client /etc/fail2ban; do
  if [ -e "$p" ] && ! mountpoint -q -- "$p" && ! owned "$p" && ! has_mount_below "$p"; then
    printf '%s\n' "$p" >> "$work/files"
  fi
done
sort -u -o "$work/files" "$work/files"
show "Программы и данные к удалению" "$work/files"
remove_files
files_removed=$removed
if [ -z "$dry" ]; then
  for d in bin etc games include lib sbin share share/man share/ca-certificates src; do install -d -m 755 "/usr/local/$d"; done
  [ -e /usr/local/man ] || ln -s share/man /usr/local/man
  { grep '^/usr/local/' "$work/owned" || true; } | while IFS= read -r d; do [ -e "$d" ] || install -d -m 755 "$d"; done
fi

step="задания и настройки"
removed=0
{
  find /etc/cron.d /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly /etc/cron.yearly \
    /etc/profile.d /etc/update-motd.d /etc/logrotate.d /etc/sudoers.d /etc/init.d /etc/apt/preferences.d \
    /etc/apt/auth.conf.d -maxdepth 1 \( -type f -o -type l \) 2>/dev/null || true
} | { grep -Ev '^/etc/sudoers\.d/90-cloud-init-users$|^/etc/apt/(preferences|auth\.conf)\.d/.*ubuntu' || true; } \
  | unowned > "$work/files"
for f in /etc/rc.local /etc/ld.so.preload /etc/apt/auth.conf; do
  if [ -e "$f" ] && ! owned "$f"; then printf '%s\n' "$f" >> "$work/files"; fi
done
find /etc/apt/apt.conf.d -maxdepth 1 -type f | unowned | while IFS= read -r f; do
  grep -qi proxy "$f" && printf '%s\n' "$f"
done >> "$work/files" || true
find /var/spool/cron/crontabs /var/spool/cron/atjobs /var/spool/cron/atspool -mindepth 1 -maxdepth 1 2>/dev/null >> "$work/files" || true
show "Задания и настройки к удалению" "$work/files"
if [ -z "$dry" ]; then
  { grep '^/etc/init\.d/' "$work/files" || true; } | while IFS= read -r f; do update-rc.d -f "${f##*/}" remove || true; done
fi
remove_files
jobs_removed=$removed
default_path='PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin"'
if [ "$(cat /etc/environment 2>/dev/null)" != "$default_path" ]; then
  [ -n "$dry" ] && echo "Верну /etc/environment к исходному"
  [ -n "$dry" ] || printf '%s\n' "$default_path" > /etc/environment
fi
# В /etc/hosts оставляем только адреса самого сервера
names=" $(hostname 2>/dev/null || true) $(hostname -f 2>/dev/null || true) "
awk -v names="$names" '/^[[:space:]]*(#|$)/ || $1 ~ /^(127\.|::1$|fe00::|ff0[0-9]::)/ { print; next }
  { for (i = 2; i <= NF; i++) if (index(names, " " $i " ")) { print; next } }' /etc/hosts > "$work/hosts"
if ! cmp -s "$work/hosts" /etc/hosts; then
  [ -n "$dry" ] && echo "Уберу из /etc/hosts строк: $(($(lines /etc/hosts) - $(lines "$work/hosts")))"
  [ -n "$dry" ] || cat "$work/hosts" > /etc/hosts
fi
[ -n "$dry" ] || ldconfig

step="источники пакетов"
removed=0
find /etc/apt/sources.list.d -maxdepth 1 \( -type f -o -type l \) ! -name 'ubuntu*' | { grep -Eiv "$keep_path" || true; } > "$work/files"
: > "$work/keys"
while IFS= read -r f; do
  grep -hoE 'signed-by=[^] ]+' "$f" | cut -d= -f2 >> "$work/keys" || true
  awk 'tolower($1) == "signed-by:" && $2 ~ /^\// { print $2 }' "$f" >> "$work/keys"
done < "$work/files"
{
  cat /etc/apt/sources.list 2>/dev/null || true
  find /etc/apt/sources.list.d -maxdepth 1 \( -type f -o -type l \) | { grep -vxFf "$work/files" || true; } | tr '\n' '\0' | xargs -0 -r cat
} > "$work/sources"
while IFS= read -r k; do
  if [ -e "$k" ] && ! owned "$k" && ! grep -qF -- "$k" "$work/sources"; then printf '%s\n' "$k" >> "$work/files"; fi
done < <(sort -u "$work/keys")
show "Источники пакетов к удалению" "$work/files"
remove_files
sources_removed=$removed
if [ -z "$dry" ] && ! "${apt[@]}" update; then
  fail "apt-get update не прошёл после очистки источников пакетов"
fi

step="пользователи"
users_removed=$(lines "$work/users")
while IFS= read -r u; do
  run userdel -f "$u" || true
done < "$work/users"
homes=$(awk -F: 'NR == FNR { gone[$1]; next } !($1 in gone) { print $6 }' "$work/users" /etc/passwd)
home=$(awk -F: -v u="$user" '$1 == u { print $6 }' /etc/passwd)
removed=0
while IFS= read -r e; do
  if [ "$e" = "$home" ] || mountpoint -q -- "$e" || has_mount_below "$e"; then continue; fi
  grep -qxF -- "$e" <<< "$homes" || printf '%s\n' "$e" >> "$work/files"
done < <(find /home -mindepth 1 -maxdepth 1 | sort)
show "Папки в /home к удалению" "$work/files"
remove_files
if [ -n "$home" ] && [[ $home == /home/?* ]] && [ -d "$home" ] && ! has_mount_below "$home"; then
  find "$home" -mindepth 1 -maxdepth 1 > "$work/files"
  show "Домашняя папка $user, к удалению" "$work/files"
  remove_files
  if [ -z "$dry" ]; then
    cp -a /etc/skel/. "$home/"
    chown -R "$user:" "$home"
  fi
fi
# Ключи SSH: у root только ключ выкладки, у остальных никаких
keys_removed=$(grep -vcF "$key" /root/.ssh/authorized_keys 2>/dev/null || true)
keys_removed=${keys_removed:-0}
awk -F: -v u="$user" '$1 != "root" && $1 != u && $6 != "" && $6 != "/" { print $6 }' /etc/passwd | sort -u \
  | while IFS= read -r h; do
    for f in "$h/.ssh/authorized_keys" "$h/.ssh/authorized_keys2"; do
      if [ -f "$f" ]; then printf '%s\n' "$f"; fi
    done
  done > "$work/files"
keys_removed=$((keys_removed + $(lines "$work/files")))
show "Ключи SSH других пользователей к удалению" "$work/files"
remove_files
if [ -z "$dry" ]; then
  grep -m 1 -F "$key" /root/.ssh/authorized_keys > /root/.ssh/authorized_keys.new
  chmod 600 /root/.ssh/authorized_keys.new
  mv /root/.ssh/authorized_keys.new /root/.ssh/authorized_keys
  find /root/.ssh -mindepth 1 -maxdepth 1 ! -name authorized_keys -exec rm -rf {} +
fi
find /root -mindepth 1 -maxdepth 1 ! -name .ssh > "$work/files"
show "Папка root, к удалению" "$work/files"
remove_files
if [ -z "$dry" ]; then
  cp /usr/share/base-files/dot.bashrc /root/.bashrc 2>/dev/null || true
  cp /usr/share/base-files/dot.profile /root/.profile 2>/dev/null || true
fi
# Пароли: входа по паролю нет ни у кого
awk -F: '$2 ~ /^\$/ { print $1 }' /etc/shadow > "$work/passwords"
show "Пароли к блокировке" "$work/passwords"
while IFS= read -r u; do
  run usermod -p '*' "$u"
done < "$work/passwords"
sshd_keys=$(sshd -T 2>/dev/null | awk '$1 == "authorizedkeysfile" { $1 = ""; print }' || true)
case "$sshd_keys" in "" | " .ssh/authorized_keys .ssh/authorized_keys2" | " .ssh/authorized_keys") ;; *) say "::warning::sshd берёт ключи ещё из других мест, их очистка не трогала" ;; esac

step="брандмауэр и сертификаты"
removed=0
find /usr/share/ca-certificates -type f | unowned > "$work/files"
show "Сертификаты к удалению" "$work/files"
remove_files
if [ -z "$dry" ]; then
  update-ca-certificates --fresh >/dev/null
  if command -v ufw >/dev/null; then
    ufw --force reset >/dev/null || true
    find /etc/ufw -maxdepth 1 -regex '.*\.rules\.[0-9_]+' -delete || true
  fi
fi

step="обновление системы"
upgrades=$(apt-get -s full-upgrade 2>/dev/null | grep -c '^Inst' || true)
if [ -z "$dry" ]; then
  "${apt[@]}" full-upgrade
  "${apt[@]}" autoremove --purge
  dpkg-query -W -f='${db:Status-Abbrev} ${Package}\n' | awk '$1 == "rc" { print $2 }' | xargs -r dpkg --purge || true
  apt-get clean
  systemctl start apt-daily.timer apt-daily-upgrade.timer || true
fi

step="логи"
find /tmp /var/tmp /var/crash /var/backups /var/mail -xdev -mindepth 1 -maxdepth 1 > "$work/files" 2>/dev/null || true
removed=0
remove_files
if [ -z "$dry" ]; then
  journalctl --rotate || true
  journalctl --vacuum-time=1s || true
  find /var/log -xdev -type f \( -name '*.gz' -o -name '*.xz' -o -name '*.zst' -o -name '*.[0-9]' -o -name '*.old' \) -delete || true
  find /var/log -xdev -type f ! -path '/var/log/journal/*' -exec truncate -s 0 {} + || true
fi

step="отчёт"
disks=$(lsblk -dn -o TYPE 2>/dev/null | grep -c '^disk$' || true)
mounts=$(findmnt -rn -o TARGET,SOURCE,FSTYPE | awk '$2 ~ /^\/dev\// && $2 !~ /loop/ && $3 != "squashfs" && $1 != "/" && $1 !~ /^\/boot(\/|$)/ { print $1 }')
nets=$({ findmnt -rn -t nfs,nfs4,cifs,smb3,fuse.s3fs,fuse.sshfs,fuse.rclone -o TARGET || true; } | wc -l)
say "Очистка сервера$([ -z "$dry" ] || echo ' (пробная, ничего не менял)'):"
say "- службы и таймеры: $units_removed"
say "- пакеты: $(lines "$work/extra") поставленных поверх образа и $(lines "$work/leftover") остатков настроек; оставлено из осторожности: $kept_pkgs"
say "- снапы: $(lines "$work/snaps")"
say "- программы и данные в /opt, /srv, /usr/local, корне, данные служб: $files_removed"
say "- задания cron и настройки: $jobs_removed; источники пакетов и ключи к ним: $sources_removed"
say "- пользователи: удалено $users_removed, у $user пустая домашняя папка; пароли заблокированы: $(lines "$work/passwords")"
say "- ключи SSH: убрано $keys_removed, у root остался только ключ выкладки"
say "- обновлений системы: $upgrades"
if [ -n "$mounts" ]; then
  mapfile -t mnt <<< "$mounts"
  size=$(df -B1G --output=size "${mnt[@]}" 2>/dev/null | awk 'NR > 1 { s += $1 } END { print s + 0 }' || true)
  say "::warning::Отдельные диски: $(wc -l <<< "$mounts"), всего $size ГБ, их содержимое не трогал"
fi
if [ "$disks" -gt 1 ]; then say "- дисков у ВМ: $disks"; fi
if [ "$nets" -gt 0 ]; then say "::warning::Сетевые папки: $nets, не трогал"; fi

#!/usr/bin/env bash
# Проверка тестового APK на эмуляторе Android (workflow «Тестовый APK»): ставит приложение,
# запускает, ждёт выбор города с городами из https://vacante.kz/app/data, открывает Алматы и
# ждёт ленту вакансий. Снимки экрана и журнал телефона кладёт в папку для артефакта прогона.
#
# Запуск: check-apk.sh <apk> <папка для снимков> <имя пакета>
set -euo pipefail

apk=$1
out=$2
pkg=$3
mkdir -p "$out"

fail() {
  echo "::error::Тестовый APK: $1"
  adb exec-out screencap -p > "$out/error.png" || true
  adb logcat -d > "$out/logcat.txt" || true
  exit 1
}

# Что сейчас на экране: дерево интерфейса, как его видят программы чтения с экрана
screen() {
  adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1 || true
  adb exec-out cat /sdcard/ui.xml 2> /dev/null || true
}

# Ждёт до $2 секунд, пока на экране появится текст по шаблону $1, и печатает экран
wait_for() {
  local pattern=$1 seconds=$2 ui
  local deadline=$((SECONDS + seconds))
  while ((SECONDS < deadline)); do
    adb shell pidof "$pkg" > /dev/null || fail "приложение закрылось"
    ui=$(screen)
    if grep -q 'Нет связи с сервером' <<< "$ui"; then
      fail "приложение не загрузило вакансии: на экране «Нет связи с сервером»"
    fi
    if grep -qE "$pattern" <<< "$ui"; then
      printf '%s' "$ui"
      return 0
    fi
    sleep 3
  done
  return 1
}

adb install -r "$apk" > /dev/null
adb logcat -c
adb shell monkey -p "$pkg" -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1

ui=$(wait_for 'text="Алматы"' 150) || fail "за 2,5 минуты не появился выбор города"
adb exec-out screencap -p > "$out/1-cities.png"
echo "Выбор города показан"

# Середина строки «Алматы»: bounds="[x1,y1][x2,y2]"
read -r x1 y1 x2 y2 < <(grep -o 'text="Алматы"[^>]*bounds="\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]"' <<< "$ui" \
  | head -1 | sed -E 's/.*bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]"/\1 \2 \3 \4/') \
  || fail "не нашлось, где на экране строка «Алматы»"
adb shell input tap $(((x1 + x2) / 2)) $(((y1 + y2) / 2))

wait_for 'Нравится|Мимо|Понятно' 90 > /dev/null || fail "после выбора Алматы не открылась лента вакансий"
sleep 3
adb exec-out screencap -p > "$out/2-feed.png"
echo "Лента Алматы показана"

adb logcat -d > "$out/logcat.txt"
if grep -q 'FATAL EXCEPTION' "$out/logcat.txt"; then
  fail "в журнале телефона падение (FATAL EXCEPTION)"
fi
if grep -E ' E ReactNativeJS' "$out/logcat.txt" | head -5 | grep -q .; then
  echo "::warning::Тестовый APK: ошибки JavaScript в журнале телефона (logcat.txt в артефакте apk-check)"
fi
echo "Тестовый APK работает: приложение запустилось, показало города и ленту"

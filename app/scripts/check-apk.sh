#!/usr/bin/env bash
# Проверка тестового APK на эмуляторе Android (workflow «Тестовый APK»): ставит приложение,
# запускает, ждёт выбор города с городами из https://vacante.kz/app/data, открывает Алматы и
# ждёт ленту вакансий. Снимки экрана и журнал телефона кладёт в папку для артефакта прогона,
# а текст с экрана и ошибки приложения печатает в лог прогона.
#
# Запуск: check-apk.sh <apk> <папка для снимков> <имя пакета>
set -euo pipefail

apk=$1
out=$2
pkg=$3
mkdir -p "$out"

# Что сейчас на экране: дерево интерфейса, как его видят программы чтения с экрана
screen() {
  adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1 || true
  adb exec-out cat /sdcard/ui.xml 2> /dev/null || true
}

# Тексты с экрана для лога, по одному в строке
texts() {
  grep -o 'text="[^"]\+"' "$1" | sed -E 's/^text="(.*)"$/  \1/' | head -"${2:-30}" || true
}

fail() {
  echo "::error::Тестовый APK: $1"
  adb exec-out screencap -p > "$out/error.png" 2> /dev/null || true
  adb logcat -d > "$out/logcat.txt" 2> /dev/null || true
  echo "--- Журнал телефона: падения и ошибки приложения ---"
  grep -E "AndroidRuntime|FATAL|ReactNativeJS|ReactNative|SoLoader|$pkg" "$out/logcat.txt" | tail -80 || true
  echo "--- Видит ли эмулятор vacante.kz ---"
  adb shell ping -c 1 -W 3 vacante.kz 2>&1 | head -2 || true
  echo "--- Текст на экране ---"
  screen > "$out/error.xml"
  texts "$out/error.xml" 40
  exit 1
}

# Нажимает на строку с текстом $1 в последнем снимке экрана $out/ui.xml: bounds="[x1,y1][x2,y2]"
tap_text() {
  local x1 y1 x2 y2
  read -r x1 y1 x2 y2 < <(grep -o "text=\"$1\"[^>]*bounds=\"\\[[0-9]*,[0-9]*\\]\\[[0-9]*,[0-9]*\\]\"" "$out/ui.xml" \
    | head -1 | sed -E 's/.*bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]"/\1 \2 \3 \4/') \
    || fail "не нашлось, где на экране «$1»"
  adb shell input tap $(((x1 + x2) / 2)) $(((y1 + y2) / 2))
}

# Ждёт до $2 секунд, пока на экране появится текст по шаблону $1; экран остаётся в $out/ui.xml.
# «Нет связи с сервером» сразу после включения эмулятора бывает, пока у него не поднялась сеть:
# тогда нажимает «Попробовать снова», как сделал бы человек, и только после пяти неудач сдаётся
wait_for() {
  local pattern=$1 seconds=$2 retries=0
  local deadline=$((SECONDS + seconds))
  while ((SECONDS < deadline)); do
    screen > "$out/ui.xml"
    if grep -qE "$pattern" "$out/ui.xml"; then
      return 0
    fi
    if grep -q 'Нет связи с сервером' "$out/ui.xml"; then
      retries=$((retries + 1))
      ((retries <= 5)) || fail "приложение не загрузило вакансии: на экране «Нет связи с сервером»"
      echo "На экране «Нет связи с сервером», нажимаю «Попробовать снова» ($retries)"
      sleep 5
      tap_text "Попробовать снова"
    fi
    adb shell pidof "$pkg" > /dev/null || fail "приложение закрылось"
    sleep 3
  done
  return 1
}

# Есть ли у эмулятора интернет: Android сам проверяет его и помечает сеть VALIDATED
wait_network() {
  local deadline=$((SECONDS + 90))
  while ((SECONDS < deadline)); do
    if adb shell dumpsys connectivity 2> /dev/null | grep -q VALIDATED; then
      echo "Сеть на эмуляторе есть"
      return 0
    fi
    sleep 3
  done
  echo "::warning::Тестовый APK: эмулятор за 90 секунд не подтвердил выход в интернет"
}

wait_network
adb install -r "$apk" > /dev/null
adb logcat -c
adb shell monkey -p "$pkg" -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1

# Процесс приложения появляется не сразу после команды запуска
for _ in $(seq 1 20); do
  adb shell pidof "$pkg" > /dev/null && break
  sleep 1
done
adb shell pidof "$pkg" > /dev/null || fail "приложение не запустилось"

wait_for 'text="Алматы"' 150 || fail "за 2,5 минуты не появился выбор города"
adb exec-out screencap -p > "$out/1-cities.png"
echo "Выбор города показан:"
texts "$out/ui.xml" 12

tap_text "Алматы"

wait_for 'Откликнуться|Понятно' 90 || fail "после выбора Алматы не открылась лента вакансий"
sleep 3
adb exec-out screencap -p > "$out/2-feed.png"
screen > "$out/ui.xml"
echo "Лента Алматы показана:"
texts "$out/ui.xml" 25

adb logcat -d > "$out/logcat.txt"
if grep -q 'FATAL EXCEPTION' "$out/logcat.txt"; then
  fail "в журнале телефона падение (FATAL EXCEPTION)"
fi
if grep -E ' E ReactNativeJS' "$out/logcat.txt" | head -5 | grep -q .; then
  echo "::warning::Тестовый APK: ошибки JavaScript в журнале телефона"
  grep -E ' E ReactNativeJS' "$out/logcat.txt" | head -10
fi
echo "Тестовый APK работает: приложение запустилось, показало города и ленту"

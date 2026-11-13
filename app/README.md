# Vacante — вакансии свайпами

Одно приложение на Expo (React Native) для трёх мест:

- **Telegram Mini App** — веб-версия на https://vacante.kz/app/, открывается кнопкой «Вакансии» в @vacantekz_bot.
- **Google Play** (и позже **App Store**) — нативные сборки из того же кода.

Данные — статичные JSON, которые сайт пересобирает каждый час (`vacante/site/appfeed.py`):
`/app/data/index.json` (города, сферы) и `/app/data/<город>.json` (до 400 свежих вакансий).
Всё, что делает пользователь (город, язык, просмотренные, избранное), хранится только на его телефоне.

## Разработка

```bash
cd app
npm ci
npx expo start        # w — в браузере, или QR-код в Expo Go на телефоне
npx tsc --noEmit      # проверка типов
```

## Выкладка

- Веб / Mini App: при пуше в `main` workflow «Приложение» собирает `dist` в ветку `app-web`,
  а «Обновление вакансий» кладёт её на сайт в `/app/`.
- Тестовый APK для Android: при пуше в `main` workflow «Тестовый APK» (`android-test.yml`)
  собирает его на GitHub без аккаунтов, проверяет на эмуляторе (`scripts/check-apk.sh`:
  выбор города и лента) и кладёт по постоянной ссылке
  https://github.com/mirasito/vacante/releases/download/app-test/vacante-test.apk.
  Пакет `kz.vacante.app.test`, название «Vacante тест» (`app.config.js`), подпись общим тестовым
  ключом шаблона React Native: для Google Play такой APK не годится. Входа в нём пока нет,
  профиль, отклики и напоминания работают только в Telegram.
- Google Play: workflow «Google Play» (`android.yml`, запуск вручную) собирает `.aab` на GitHub,
  подписывает ключом загрузки с сервера Vacante (`/etc/vacante/android-upload.jks`, создаётся при
  первой сборке) и кладёт в https://github.com/mirasito/vacante/releases/download/app-play/vacante-play.aab.
  versionCode = номер прогона, название версии — `expo.version` в `app.json`. Файл загружают
  в Play Console вручную. Аккаунт разработчика: корпоративный, ТОО «Vacante».
- App Store: нужен Apple Developer ($99 в год), пока не оформлен.

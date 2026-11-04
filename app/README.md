# Vacante — вакансии свайпами

Одно приложение на Expo (React Native) для трёх мест:

- **Telegram Mini App** — веб-версия на https://vacante.kz/app/, открывается кнопкой «Вакансии» в @vacantekz_bot.
- **Google Play** и **App Store** — нативные сборки из того же кода через EAS.

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
- Сторы (нужны аккаунты владельца): Expo (бесплатно), Google Play Console ($25 один раз),
  Apple Developer ($99 в год). Дальше `npx eas-cli build -p android` / `-p ios` и `eas submit`.

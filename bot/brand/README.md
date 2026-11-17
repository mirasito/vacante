# Оформление @vacantekz_bot

Описание, короткое описание, меню команд (RU и KZ) и кнопку «Вакансии» ставит workflow «Бот»
(`.github/workflows/bot.yml`) из `bot/profile.json` при каждом изменении `bot/**` или ручном запуске.
Аватар и картинку к описанию Bot API менять не умеет, их ставят в @BotFather:

1. Открыть @BotFather → `/mybots` → `@vacantekz_bot` → **Edit Bot**.
2. **Edit Botpic** → отправить `avatar.png` (640×640, знак «.в» с колпаком; запасной вариант `avatar-wordmark.png`).
3. **Edit Description Picture** → отправить `description-picture.png` (640×360, видна в пустом чате до «Старт»).
   Если такого пункта нет, команда `/setdescriptionpic` → выбрать бота → отправить картинку.

Картинки отправлять как фото (не файлом).

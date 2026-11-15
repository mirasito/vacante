-- Прямые кнопки связи (server/src/go.ts): «WhatsApp», «Позвонить» и «Telegram» на сайте, в каналах и в подборках
-- бота ведут на /go/<вакансия>/<вид>, и сервер сразу отправляет человека к работодателю.
-- Контакты работодателя из открытого поста в канале хранятся только здесь, на сервере в Казахстане:
-- в открытые данные сайта и в ветку data они не попадают.

CREATE TABLE vacancy_contacts (
  vacancy_id TEXT PRIMARY KEY,   -- id вакансии на сайте: <канал>-<номер поста>
  whatsapp TEXT,                 -- +77011234567
  phone TEXT,
  telegram TEXT,                 -- имя в Telegram без @
  found INTEGER NOT NULL,        -- 0: пост прочитан, контактов нет (или пост удалён) — спросим снова через сутки
  checked_at TEXT NOT NULL
);

-- Нажатия на кнопки связи: обезличенное число за день по источнику кнопки (web, tg, bot) и виду
-- (wa, call, tg; miss — контакта не нашлось, человек ушёл на исходный пост)
CREATE TABLE contact_clicks (
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('wa', 'call', 'tg', 'miss')),
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, kind)
);

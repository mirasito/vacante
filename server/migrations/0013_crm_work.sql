-- CRM работодателей, этапы 2–4: ручная правка, склейка, статус и история, фото, профили работодателей
-- в боте, привязка вакансий из бота к заведению, оплаты и данные компании с hh.

-- Правки руками лежат отдельно от того, что приносит сбор: часовой импорт их не трогает
ALTER TABLE employers ADD COLUMN edits TEXT NOT NULL DEFAULT '{}';   -- name, legal_name, bin, category, website, instagram, telegram, about
ALTER TABLE employers ADD COLUMN status TEXT NOT NULL DEFAULT '';    -- '' | sent | replied | client | no
ALTER TABLE employers ADD COLUMN next_at TEXT;                       -- следующий шаг, дата YYYY-MM-DD
ALTER TABLE employers ADD COLUMN note TEXT NOT NULL DEFAULT '';
-- Открытая карточка работодателя на hh (api.hh.ru/employers/{id}): только данные компании
ALTER TABLE employers ADD COLUMN hh_id TEXT;
ALTER TABLE employers ADD COLUMN hh_logo TEXT;
ALTER TABLE employers ADD COLUMN hh_site TEXT;
ALTER TABLE employers ADD COLUMN hh_about TEXT;
ALTER TABLE employers ADD COLUMN hh_checked_at TEXT;

-- После склейки старое название ведёт к работодателю, в которого склеили
CREATE TABLE employer_aliases (
  key TEXT PRIMARY KEY,
  employer_id INTEGER NOT NULL REFERENCES employers (id) ON DELETE CASCADE
);

ALTER TABLE venues ADD COLUMN edits TEXT NOT NULL DEFAULT '{}';      -- name, city, address, instagram, telegram, website, twogis
ALTER TABLE venues ADD COLUMN review TEXT NOT NULL DEFAULT '';       -- '' | pending | rejected: заведение от работодателя ждёт проверки
ALTER TABLE venues ADD COLUMN removed INTEGER NOT NULL DEFAULT 0;     -- скрыто из карточки

-- История работы с работодателем: заметки, звонки, сообщения, смена статуса, заявки и заведения из бота
CREATE TABLE activities (
  id INTEGER PRIMARY KEY,
  employer_id INTEGER NOT NULL REFERENCES employers (id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- note | call | message | status | venue | member | payment | merge
  text TEXT NOT NULL,
  by TEXT NOT NULL DEFAULT 'admin'     -- admin | employer | system
);
CREATE INDEX activities_employer ON activities (employer_id, at);

-- Фото заведений, которые загрузили в админке (файлы в папке кружков, чтобы попадали в ночной бэкап)
CREATE TABLE media (
  id INTEGER PRIMARY KEY,
  venue_id INTEGER NOT NULL REFERENCES venues (id) ON DELETE CASCADE,
  file TEXT NOT NULL UNIQUE,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  at TEXT NOT NULL
);

-- Кто управляет профилем работодателя в боте. confirmed_at — подтвердили в админке (или профиль создан
-- сам при первой вакансии из бота у нового работодателя)
CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  employer_id INTEGER NOT NULL REFERENCES employers (id) ON DELETE CASCADE,
  tg_chat INTEGER NOT NULL,
  name TEXT,                           -- имя и @username из Telegram, как в карточке модерации бота
  claimed_at TEXT NOT NULL,
  confirmed_at TEXT,
  rejected_at TEXT,
  UNIQUE (employer_id, tg_chat)
);
CREATE INDEX members_chat ON members (tg_chat);

-- Вакансии и смены из бота: кто разместил и для какого заведения (выбор работодателя в боте)
CREATE TABLE bot_jobs (
  job_id INTEGER PRIMARY KEY,
  tg_chat INTEGER NOT NULL,
  employer_id INTEGER REFERENCES employers (id) ON DELETE SET NULL,
  venue_id INTEGER REFERENCES venues (id) ON DELETE SET NULL,
  asked_at TEXT                        -- когда спросили «Для какого заведения?»
);

-- Копия оплат из бота (D1 payments): размещение и «Срочно», для выручки по работодателям
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,              -- id оплаты в D1
  job_id INTEGER NOT NULL,
  employer_id INTEGER REFERENCES employers (id) ON DELETE SET NULL,
  kind TEXT NOT NULL,                  -- post | boost
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,                -- pending | confirmed | rejected
  at TEXT NOT NULL
);
CREATE INDEX payments_employer ON payments (employer_id);

-- Что работодатель сейчас делает в боте: ищет свою компанию или добавляет заведение
CREATE TABLE crm_bot_state (
  tg_chat INTEGER PRIMARY KEY,
  employer_id INTEGER,
  city TEXT,
  query TEXT,                          -- что искали в «Найти свою компанию»
  at TEXT NOT NULL
);

-- Этап 1: соискатели и их профили. Всё о людях живёт только здесь, на сервере в Казахстане.
-- Удаление соискателя (DELETE FROM seekers) каскадом стирает профиль, кружок, ссылки и просмотры.

-- Соискатель появляется только после согласия: id из Telegram, имя, язык, согласия с датой и версией текста
CREATE TABLE seekers (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'ru' CHECK (lang IN ('ru', 'kk')),
  consent_version TEXT NOT NULL,
  consent_at TEXT NOT NULL,
  -- Показывать ли профиль в базе кандидатов (вторая галочка, по желанию); NULL = нет
  base_consent_at TEXT,
  -- Разрешил ли боту писать первым (Telegram.WebApp.requestWriteAccess)
  write_access INTEGER NOT NULL DEFAULT 0,
  -- Когда приложение попросило номер кнопкой Telegram: контакт, пришедший боту в ближайшие
  -- 10 минут, идёт в профиль, а не в отклик, который человек мог начать в боте раньше
  phone_asked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- Последний вход: через 12 месяцев без входа спросим, оставить ли профиль
  seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Анкета: шесть экранов с кнопками и поля по желанию
CREATE TABLE profiles (
  seeker_id INTEGER PRIMARY KEY REFERENCES seekers (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  district TEXT,
  roles TEXT NOT NULL,                -- JSON: до трёх профессий
  experience TEXT NOT NULL,           -- none, lt1, 1to3, gt3
  employment TEXT NOT NULL,           -- JSON: full, shifts, part, rotation
  pay_from INTEGER,                   -- тенге
  pay_period TEXT,                    -- month или shift
  start TEXT NOT NULL,                -- today, week, 2weeks, later
  phone TEXT,                         -- +77012345678
  languages TEXT NOT NULL DEFAULT '[]',
  about TEXT,
  med_book INTEGER NOT NULL DEFAULT 0,
  driver INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX profiles_city ON profiles (city);

-- Кружок: один на соискателя. Файл лежит в папке videos, номер файла в Telegram нужен, чтобы скачать его заново
CREATE TABLE videos (
  seeker_id INTEGER PRIMARY KEY REFERENCES seekers (id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  file_unique_id TEXT NOT NULL,
  file TEXT,
  poster TEXT,
  duration INTEGER NOT NULL,
  size INTEGER,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Ссылки на профиль: случайный код из 8 знаков. Общая (из профиля) или своя у каждого отклика
CREATE TABLE links (
  code TEXT PRIMARY KEY,
  seeker_id INTEGER NOT NULL REFERENCES seekers (id) ON DELETE CASCADE,
  application_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at TEXT
);
CREATE INDEX links_seeker ON links (seeker_id);

-- Кто открывал профиль: через какую ссылку и когда. IP-адреса и браузеры не храним
CREATE TABLE views (
  id INTEGER PRIMARY KEY,
  seeker_id INTEGER NOT NULL REFERENCES seekers (id) ON DELETE CASCADE,
  link_code TEXT,
  application_id INTEGER,
  -- Кто открыл, если известно: заведение из отклика
  viewer TEXT,
  phone_shown INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX views_seeker ON views (seeker_id, at);

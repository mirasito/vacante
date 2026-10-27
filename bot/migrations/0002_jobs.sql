-- Вакансии, которые работодатели размещают через бота, и отклики на них
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employer_chat INTEGER NOT NULL,
  employer_name TEXT,                      -- имя и @username в Telegram, для модерации
  status TEXT NOT NULL DEFAULT 'draft',    -- draft → pending → approved | rejected; approved → closed
  step TEXT,                               -- какой вопрос анкеты сейчас задан (пока draft)
  city TEXT,
  title TEXT,
  company TEXT,
  salary TEXT,
  schedule TEXT,
  address TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT
);
CREATE INDEX jobs_employer ON jobs (employer_chat);
CREATE INDEX jobs_status ON jobs (status);

CREATE TABLE applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX applications_job ON applications (job_id);

-- Что бот ждёт от человека текстом: анкету вакансии (post) или отклик (apply)
CREATE TABLE dialogs (
  chat_id INTEGER PRIMARY KEY,
  mode TEXT NOT NULL,
  job_id INTEGER NOT NULL
);

-- Модераторы: админы каналов vacante, подтвердившиеся командой /admin
CREATE TABLE admins (
  chat_id INTEGER PRIMARY KEY,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

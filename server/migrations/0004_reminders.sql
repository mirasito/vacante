-- Этап 1, напоминания: «Написать ещё раз», «Что с откликом?», собеседование, выход на работу,
-- кружок для профиля, итог недели и свои. Системные планировщик сам заводит по откликам и профилю,
-- а пришедшие отправляет в бот с 9:00 до 21:00 по Казахстану и не больше двух в день.
-- Удаление соискателя или отклика стирает и его напоминания.

CREATE TABLE reminders (
  id INTEGER PRIMARY KEY,
  seeker_id INTEGER NOT NULL REFERENCES seekers (id) ON DELETE CASCADE,
  application_id INTEGER REFERENCES applications (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'write_again', 'status_check', 'interview_eve', 'interview_soon', 'how_was_it', 'start_eve', 'profile', 'week', 'custom'
  )),
  -- У системных: тип и то, к чему они привязаны. Новая дата собеседования даёт новый ключ,
  -- и прежние напоминания о нём отменяются. У своих NULL
  key TEXT,
  text TEXT,                           -- только у своих
  due_at TEXT NOT NULL,                -- когда напомнить, UTC
  expires_at TEXT,                     -- после этого уже не отправляем
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'sent', 'done', 'dismissed')),
  closed_by TEXT CHECK (closed_by IN ('seeker', 'system')),
  sent_at TEXT,
  message_id INTEGER,                  -- сообщение в боте: после нажатия кнопки его можно поправить
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (seeker_id, key)
);
CREATE INDEX reminders_due ON reminders (status, due_at);
CREATE INDEX reminders_seeker ON reminders (seeker_id, due_at);
CREATE INDEX reminders_application ON reminders (application_id);

-- Настройки в профиле: какие группы напоминаний выключены (JSON) и присылать ли их в бот
ALTER TABLE seekers ADD COLUMN reminders_off TEXT NOT NULL DEFAULT '[]';
ALTER TABLE seekers ADD COLUMN reminders_bot INTEGER NOT NULL DEFAULT 1;

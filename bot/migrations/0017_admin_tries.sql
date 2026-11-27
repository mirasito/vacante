-- Подбор пароля админки через /api/crm и /api/jobs (2026-11-27, проверка сайта): неверные ключи
-- с одного адреса за окно. Строка пишется только при неверном ключе, чистится раз в час (crm.js, cleanTries).
CREATE TABLE IF NOT EXISTS admin_tries (
  ip TEXT PRIMARY KEY,
  start INTEGER NOT NULL,   -- начало окна, секунды Unix
  wrong INTEGER NOT NULL    -- неверных ключей в этом окне
);

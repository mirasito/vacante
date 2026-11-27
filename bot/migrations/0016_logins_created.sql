-- Чистка старых кодов входа на сайт идёт по created_at раз в час (bot/src/login.js, cleanLogins).
-- Без индекса каждый такой DELETE читал всю таблицу logins (2026-11-27, проверка сайта).
CREATE INDEX IF NOT EXISTS logins_created ON logins (created_at);

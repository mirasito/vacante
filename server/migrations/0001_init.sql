-- Первая схема сервера. Таблицы профилей, откликов и напоминаний добавят следующие миграции,
-- а до согласия человека на обработку данных сервер о нём ничего не записывает.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO meta (key, value) VALUES ('created_at', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

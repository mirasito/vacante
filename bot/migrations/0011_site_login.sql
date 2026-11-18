-- Вход на сайт через бота (2026-11-18): сайт берёт код, человек открывает t.me/<бот>?start=login_<код>
-- и подтверждает кнопкой, сайт забирает подписанный ключ входа. Код живёт 10 минут и удаляется, как только сайт его забрал.
CREATE TABLE logins (
  code TEXT PRIMARY KEY,
  chat_id INTEGER,                          -- кто подтвердил; пусто, пока не подтвердили
  first_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

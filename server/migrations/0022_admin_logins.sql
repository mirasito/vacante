-- Попытки входа в админку на сервере (server/src/admin-logins.ts): каждая неверная и первая верная
-- с адреса за шесть часов. Хранятся 30 дней, видны в админке во вкладке «Входы».
CREATE TABLE admin_logins (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,                     -- ISO 8601, UTC
  result TEXT NOT NULL CHECK (result IN ('ok', 'wrong', 'blocked')),
  ip TEXT NOT NULL,                     -- адрес из X-Forwarded-For (Caddy), «local» без него
  ua TEXT NOT NULL,                     -- User-Agent, не длиннее 200 знаков
  path TEXT NOT NULL                    -- какой адрес админки спросили
);
CREATE INDEX admin_logins_at ON admin_logins (at);

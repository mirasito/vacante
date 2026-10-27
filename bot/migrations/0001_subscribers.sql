-- Подписчики бота: что присылать и кому
CREATE TABLE subscribers (
  chat_id INTEGER PRIMARY KEY,
  city TEXT,                               -- NULL = весь Казахстан
  categories TEXT NOT NULL DEFAULT '',     -- сферы через запятую, пусто = любые
  perks TEXT NOT NULL DEFAULT '',          -- условия через «|», salary = «С зарплатой»
  min_pay INTEGER NOT NULL DEFAULT 0,      -- зарплата от, ₸ в месяц
  active INTEGER NOT NULL DEFAULT 0,       -- 1 после «Готово», 0 после /stop
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Тарифы (2026-11-18): Базовый (платное размещение, POST_PRICE) и Про (бывшее «Срочно», BOOST_PRICE на BOOST_DAYS),
-- плюс пакеты Про (PACKS). Про можно выбрать сразу при размещении: одна оплата за размещение и подъём.
ALTER TABLE jobs ADD COLUMN pro INTEGER NOT NULL DEFAULT 0;   -- 1: размещается по тарифу Про
ALTER TABLE jobs ADD COLUMN pro_reported TEXT;                -- boost_until, по которому уже прислали итог Про

-- Оплата пакета: kind = 'pack', job_id = 0, pack = сколько вакансий Про, days = сколько дней действует пакет
ALTER TABLE payments ADD COLUMN pack INTEGER;
ALTER TABLE payments ADD COLUMN employer_name TEXT;

-- Остаток пакетов Про у работодателя
CREATE TABLE credits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employer_chat INTEGER NOT NULL,
  total INTEGER NOT NULL,
  left INTEGER NOT NULL,
  expires_at TEXT NOT NULL,                -- UTC, как datetime('now')
  payment_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX credits_employer ON credits (employer_chat);

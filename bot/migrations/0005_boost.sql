-- Платная услуга «🔥 Срочно»: вакансия наверху списка своего города на сайте и повторный пост в канале.
-- Работодатель переводит деньги на Kaspi, модератор подтверждает перевод кнопкой в боте.
ALTER TABLE jobs ADD COLUMN boost_until TEXT;  -- до какого времени (UTC, как datetime('now')) вакансия «Срочно»

CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  employer_chat INTEGER NOT NULL,
  amount INTEGER NOT NULL,                 -- тенге
  days INTEGER NOT NULL,                   -- на сколько дней поднимаем
  status TEXT NOT NULL DEFAULT 'pending',  -- pending → confirmed | rejected
  decided_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);
CREATE INDEX payments_job ON payments (job_id);

-- Карточки оплаты у модераторов, чтобы после решения обновить их у всех
CREATE TABLE payment_notices (
  payment_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL
);
CREATE INDEX payment_notices_payment ON payment_notices (payment_id);

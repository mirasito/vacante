-- Платное размещение (2026-11-06): вакансия или смена выходит на проверку только после оплаты.
-- Новый статус jobs.status = 'payment' (ждёт оплаты) между черновиком и проверкой.
-- Оплаты размещения лежат в той же таблице payments, что и «Срочно», с kind = 'post'.
ALTER TABLE payments ADD COLUMN kind TEXT NOT NULL DEFAULT 'boost';  -- boost | post
ALTER TABLE jobs ADD COLUMN post_paid INTEGER;  -- сколько тенге заплатили за размещение (NULL — бесплатно)

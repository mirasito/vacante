-- Смены (bot/src/shift.js): работодатель публикует смену на конкретный день, соискатели жмут «Беру смену»,
-- работодатель подтверждает, а после смены отмечает, кто пришёл. Из отметок складывается надёжность.
ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'vacancy';  -- vacancy | shift
ALTER TABLE jobs ADD COLUMN shift_date TEXT;                        -- день смены по времени Казахстана, 2026-11-07
ALTER TABLE jobs ADD COLUMN shift_start TEXT;                       -- «10:00» по времени Казахстана
ALTER TABLE jobs ADD COLUMN shift_end TEXT;                         -- «22:00»; раньше начала — значит, на следующий день
ALTER TABLE jobs ADD COLUMN need INTEGER;                           -- сколько человек нужно
ALTER TABLE jobs ADD COLUMN attendance_asked INTEGER NOT NULL DEFAULT 0; -- спросили после смены, кто пришёл

-- Для смен отклик — это просьба взять смену: asked → confirmed | declined; confirmed → cancelled (сам отменил).
-- Имя из Telegram, чтобы работодатель отметил, кто пришёл. Телефон не храним: он только в сообщении работодателю
ALTER TABLE applications ADD COLUMN status TEXT;
ALTER TABLE applications ADD COLUMN name TEXT;
ALTER TABLE applications ADD COLUMN attended INTEGER;               -- 1 пришёл, 0 не пришёл, NULL ещё не отметили
ALTER TABLE applications ADD COLUMN reminded INTEGER NOT NULL DEFAULT 0;
CREATE INDEX applications_chat ON applications (chat_id);
ALTER TABLE jobs ADD COLUMN closed_full INTEGER NOT NULL DEFAULT 0;      -- закрыта, потому что набрали всех

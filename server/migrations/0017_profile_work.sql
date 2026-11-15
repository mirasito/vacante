-- Профиль под общепит (2026-11-16): где человек работал, что умеет, санкнижка тремя состояниями,
-- готовность к пробной смене и отметка «ищу работу сейчас». Всё по желанию, заполняется кнопками.

ALTER TABLE profiles ADD COLUMN jobs TEXT NOT NULL DEFAULT '[]';    -- JSON: до трёх мест {place, role, term}
ALTER TABLE profiles ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';  -- JSON: навыки из списка server/src/profile.ts SKILLS
ALTER TABLE profiles ADD COLUMN med TEXT CHECK (med IN ('yes', 'soon', 'no'));  -- санкнижка: есть, оформлю, нет; NULL — не отвечал
ALTER TABLE profiles ADD COLUMN trial INTEGER NOT NULL DEFAULT 0;   -- готов выйти на пробную смену
ALTER TABLE profiles ADD COLUMN looking_at TEXT;                    -- когда последний раз отметил «ищу сейчас»; гаснет через 30 дней

-- Прежняя галочка «есть санкнижка» становится ответом «есть»
UPDATE profiles SET med = 'yes' WHERE med_book = 1;

-- vacante 2.0: удобное время для собеседования, отмена, «пришёл/не пришёл», переписка с работодателем,
-- отзывы о заведениях и приглашения друзей. Всё привязано к соискателю или его отклику: удаление
-- профиля или отклика стирает и это (ON DELETE CASCADE).

-- Время, которое соискатель предложил работодателю: JSON-список до трёх моментов UTC
ALTER TABLE applications ADD COLUMN slots TEXT NOT NULL DEFAULT '[]';
-- Был ли человек на собеседовании и кто это отметил
ALTER TABLE applications ADD COLUMN attended TEXT CHECK (attended IN ('yes', 'no'));
ALTER TABLE applications ADD COLUMN attended_by TEXT CHECK (attended_by IN ('seeker', 'employer'));
-- «Не смогу прийти»: соискатель предупредил заранее, это не неявка
ALTER TABLE applications ADD COLUMN cancelled_at TEXT;

-- Переписка по отклику: соискатель пишет в приложении, работодатель — на странице профиля по ссылке отклика
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  by TEXT NOT NULL CHECK (by IN ('seeker', 'employer')),
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX messages_app ON messages (application_id, at);

-- Отзыв соискателя о заведении после собеседования: один на отклик. Наружу идут только средняя
-- оценка и частые метки, и только когда отзывов набралось три и больше
CREATE TABLE reviews (
  application_id INTEGER PRIMARY KEY REFERENCES applications (id) ON DELETE CASCADE,
  venue TEXT NOT NULL,                -- работодатель без регистра и лишних пробелов
  city TEXT,
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  tags TEXT NOT NULL DEFAULT '[]',
  text TEXT,
  at TEXT NOT NULL
);
CREATE INDEX reviews_venue ON reviews (venue);

-- Приглашения: свой код у каждого и кто пригласил (только счётчик, без имён)
ALTER TABLE seekers ADD COLUMN ref_code TEXT;
ALTER TABLE seekers ADD COLUMN referred_by INTEGER REFERENCES seekers (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX seekers_ref_code ON seekers (ref_code) WHERE ref_code IS NOT NULL;

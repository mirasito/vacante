-- Этап 1, отклики: куда человек откликнулся, каким способом и на какой стадии отклик.
-- Список вакансий сервер не ведёт, поэтому у отклика своя короткая копия вакансии на момент отклика.
-- Номера работодателей и переписку не храним. Удаление соискателя стирает и его отклики.

CREATE TABLE applications (
  id INTEGER PRIMARY KEY,
  seeker_id INTEGER NOT NULL REFERENCES seekers (id) ON DELETE CASCADE,
  vacancy_id TEXT NOT NULL,           -- id вакансии на vacante.kz
  title TEXT NOT NULL,
  title_kk TEXT,
  employer TEXT,
  city TEXT,
  address TEXT,
  map TEXT,                           -- адрес в 2ГИС, как в ленте
  url TEXT,                           -- карточка на vacante.kz
  source_url TEXT,                    -- исходный пост в канале, hh.kz или бот
  contact TEXT NOT NULL DEFAULT '[]', -- JSON: какие контакты были в посте (whatsapp, phone, telegram), без самих номеров
  method TEXT CHECK (method IN ('whatsapp', 'telegram', 'call', 'hh', 'bot', 'post')),
  stage TEXT NOT NULL DEFAULT 'liked' CHECK (stage IN (
    'liked', 'sent', 'seen', 'invited', 'interview', 'offer', 'hired', 'rejected', 'no_answer', 'not_interested'
  )),
  interview_at TEXT,                  -- собеседование, UTC
  start_at TEXT,                      -- день выхода на работу, ГГГГ-ММ-ДД
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE (seeker_id, vacancy_id)
);
CREATE INDEX applications_seeker ON applications (seeker_id, updated_at);

-- История стадий: кто поменял (соискатель, работодатель или система) и когда
CREATE TABLE application_events (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  by TEXT NOT NULL CHECK (by IN ('seeker', 'employer', 'system')),
  at TEXT NOT NULL
);
CREATE INDEX application_events_app ON application_events (application_id, at);
CREATE INDEX links_application ON links (application_id);

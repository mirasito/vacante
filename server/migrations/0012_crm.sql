-- CRM работодателей (админка vacante.kz/admin/, вкладка «Работодатели»): работодатель, внутри его заведения,
-- у заведений вакансии. Этап 1: всё заполняет часовой сбор на GitHub (POST /internal/crm/import), админка
-- только смотрит. Ручные правки, профили работодателей в боте, фото и история появятся следующими этапами.

-- Работодатель: бренд или компания, может нанимать в нескольких городах
CREATE TABLE employers (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,            -- название без регистра, кавычек и формы собственности
  name TEXT NOT NULL,                  -- как чаще всего пишут в вакансиях
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

-- Заведение: точка работодателя в городе. key — тот же ключ «город:название», что в venues.json
CREATE TABLE venues (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  employer_id INTEGER NOT NULL REFERENCES employers (id),
  name TEXT NOT NULL,
  city TEXT,                           -- slug: almaty, astana, … (NULL — весь Казахстан)
  address TEXT,
  lat REAL,
  lon REAL,
  instagram TEXT,
  telegram TEXT,
  website TEXT,
  avatar TEXT,                         -- файл аватара на сайте: vacante.kz/venues/<avatar>
  twogis TEXT,                         -- поиск заведения в 2ГИС
  agent_status TEXT,                   -- found | none | skip от агента «Заведения»
  added_by TEXT NOT NULL DEFAULT 'collect',  -- collect (из вакансий), потом: admin, employer
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE INDEX venues_employer ON venues (employer_id);

-- Вакансии заведения: сейчас на сайте (active = 1) и архив снятых, чтобы видеть историю найма
CREATE TABLE employer_vacancies (
  id TEXT PRIMARY KEY,                 -- id вакансии на сайте (vacante.kz/v/<id>/)
  venue_id INTEGER NOT NULL REFERENCES venues (id),
  title TEXT NOT NULL,
  category TEXT,
  salary TEXT,
  source TEXT NOT NULL,                -- telegram | hh | olx | bot
  posted_at TEXT NOT NULL,
  top_until TEXT,                      -- оплачено «Срочно» до
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX employer_vacancies_venue ON employer_vacancies (venue_id, active);

-- Проверка вакансий агентом: оформленная зарплата числами и отметка, что вакансию проверили
ALTER TABLE jobs ADD COLUMN salary_min INTEGER;
ALTER TABLE jobs ADD COLUMN salary_max INTEGER;
ALTER TABLE jobs ADD COLUMN salary_period TEXT;  -- month | day | hour
ALTER TABLE jobs ADD COLUMN reviewed_at TEXT;    -- когда агент проверил и оформил
ALTER TABLE jobs ADD COLUMN decided_by TEXT;     -- кто опубликовал или отклонил: «агент» или имя модератора

-- Карточки вакансии у модераторов, чтобы после решения обновить их у всех
CREATE TABLE notices (
  job_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL
);
CREATE INDEX notices_job ON notices (job_id);

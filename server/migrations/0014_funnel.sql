-- Воронка перезапуска: откуда пришёл человек и где он остановился.
-- До согласия о человеке ничего не записываем (см. 0002_profiles.sql), поэтому открытия приложения
-- начатые анкеты и отклики без профиля считаются обезличенно: число за день по метке источника из ссылки запуска.
-- Остальные шаги (профиль, отклик, открытие ссылки, ответ работодателя) считаются из таблиц соискателя.

CREATE TABLE funnel_counts (
  day TEXT NOT NULL,     -- день по времени Казахстана, ГГГГ-ММ-ДД
  source TEXT NOT NULL,  -- метка источника из ссылки запуска; пустая строка — без метки
  -- sent_plain — отклик без профиля: человек отказался от анкеты и отправил короткий текст без ссылки
  step TEXT NOT NULL CHECK (step IN ('open', 'profile_start', 'sent_plain')),
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, step)
);

-- Первая метка источника соискателя: пишется после согласия и больше не меняется
ALTER TABLE seekers ADD COLUMN source TEXT;
ALTER TABLE seekers ADD COLUMN source_at TEXT;

-- Отклик ушёл со ссылкой на профиль: человек ответил «Да» на «Отправили?» с включённой галочкой
ALTER TABLE applications ADD COLUMN with_link INTEGER NOT NULL DEFAULT 0;

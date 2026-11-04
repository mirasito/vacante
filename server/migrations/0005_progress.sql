-- Этап 1, цель недели и достижения. Цель: 3, 5 или 10 откликов за неделю с понедельника по времени
-- Казахстана. Строка недели появляется, когда человек выбрал или поменял цель, а закончившаяся неделя
-- записывается один раз: отклик, удалённый потом, не отнимает выполненную неделю. Достижение
-- записывается один раз, когда сделан настоящий шаг, и не пропадает. Удаление соискателя стирает и то, и другое.

CREATE TABLE goal_weeks (
  seeker_id INTEGER NOT NULL REFERENCES seekers (id) ON DELETE CASCADE,
  week TEXT NOT NULL,                  -- понедельник недели, ГГГГ-ММ-ДД по времени Казахстана
  goal INTEGER NOT NULL CHECK (goal IN (0, 3, 5, 10)),   -- 0: цель выключили
  sent INTEGER,                        -- сколько откликов отправлено; NULL, пока неделя идёт
  PRIMARY KEY (seeker_id, week)
);

CREATE TABLE achievements (
  seeker_id INTEGER NOT NULL REFERENCES seekers (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('video', 'first_sent', 'first_invite', 'first_interview', 'hired')),
  at TEXT NOT NULL,                    -- когда сделан шаг, UTC
  seen INTEGER NOT NULL DEFAULT 0,     -- приложение уже поздравило
  PRIMARY KEY (seeker_id, kind)
);

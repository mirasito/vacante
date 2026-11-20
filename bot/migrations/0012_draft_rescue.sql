-- Брошенные анкеты: одно напоминание «Продолжим?» через час (posting.js nudgeDrafts)
ALTER TABLE jobs ADD COLUMN nudged INTEGER NOT NULL DEFAULT 0;

-- Сколько человек открыли анкету работодателя, но нажали «Я ищу работу» — по дням и откуда пришли
CREATE TABLE role_switches (
  day TEXT NOT NULL,          -- по времени Казахстана
  came_from TEXT NOT NULL,    -- site, land, tg, app, menu, profile или '' (без метки)
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, came_from)
);

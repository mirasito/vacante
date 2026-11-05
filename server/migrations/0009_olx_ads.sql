-- Объявления OLX, которые Мирас забрал в своём браузере закладкой «Забрать в vacante» (server/src/olx-import.ts).
-- Только само объявление: без имени автора и телефонов (они вырезаются до записи). Часовой сбор на GitHub
-- забирает новые по imported_at (GET /internal/olx/imports), записи старше 30 дней удаляются при импорте.
CREATE TABLE olx_ads (
  id INTEGER PRIMARY KEY,            -- id объявления на OLX
  url TEXT NOT NULL,                 -- https://www.olx.kz/d/obyavlenie/…
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  salary TEXT,                       -- JSON {from, to, currency, type, arranged} или NULL
  city TEXT,                         -- название города, как его пишет OLX
  lat REAL,
  lon REAL,
  detailed INTEGER NOT NULL DEFAULT 0, -- точка точная (OLX показывает её на карте), а не центр района
  created_time TEXT,                 -- когда объявление появилось на OLX (ISO 8601)
  refreshed_time TEXT,               -- когда его подняли на OLX
  imported_at TEXT NOT NULL          -- когда забрали в vacante (ISO 8601, UTC)
);
CREATE INDEX olx_ads_imported_at ON olx_ads (imported_at);

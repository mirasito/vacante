-- Последняя попытка часового сбора OLX.kz самим сервером (server/src/olx-hourly.ts).
-- Одна строка: каждая попытка её переписывает. Видна по GET /internal/olx/hourly.
CREATE TABLE olx_hourly (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  at TEXT NOT NULL,                    -- когда начали попытку (ISO 8601, UTC)
  status TEXT NOT NULL,                -- ok, HTTP 403, timeout, bad page, network error
  pages INTEGER NOT NULL DEFAULT 0,    -- сколько страниц списка прочитано
  stored INTEGER NOT NULL DEFAULT 0,   -- сколько объявлений записано в olx_ads
  inserted INTEGER NOT NULL DEFAULT 0  -- сколько из них новые
);

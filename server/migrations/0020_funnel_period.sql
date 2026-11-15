-- Честный итог воронки за период и шаги полной анкеты.
-- Обе таблицы новые: funnel_counts не трогаем. В ней CHECK на step, и новый вид счётчика в неё не пишется
-- (на этом уже спотыкались с contact_clicks), а перестраивать рабочую таблицу ради этого незачем.
-- О человеке здесь по-прежнему ничего нет: только числа за день по метке источника.

-- Повторные открытия. Приложение помнит день прошлого открытия на самом устройстве и присылает одно число:
-- сколько дней назад оно было. Из открытий за день (funnel_counts, step = 'open') вычитаются те, чьё прошлое
-- открытие попало в тот же период, и остаются люди, а не сумма дней.
CREATE TABLE funnel_returns (
  day TEXT NOT NULL,     -- день открытия по времени Казахстана, ГГГГ-ММ-ДД
  source TEXT NOT NULL,  -- метка источника; пустая строка — без метки
  gap INTEGER NOT NULL CHECK (gap BETWEEN 1 AND 90),  -- сколько дней назад было прошлое открытие
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, gap)
);

-- Шаги полной анкеты профиля: сколько человек дошло до экрана и сколько прошло его.
-- Список экранов проверяет код (FORM_SCREENS в server/src/funnel.ts): новый экран миграции не требует.
CREATE TABLE funnel_form (
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  screen TEXT NOT NULL,  -- consent, place, roles, experience, employment, pay, home, start
  reached INTEGER NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, screen)
);

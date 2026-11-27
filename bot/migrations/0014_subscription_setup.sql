-- Настройка подписки по шагам (2026-11-27): видно, на каком экране её бросают, и кому один раз напомнить.
-- setup: до какого шага человек дошёл (bot/src/logic.js reached). NULL: только /start и все строки до этой миграции.
-- city: увидел вопрос «Где ищете работу?», cats: выбрал город, perks: открыл условия,
-- done: нажал «Готово», stopped: нажал «Остановить» или /stop.
ALTER TABLE subscribers ADD COLUMN setup TEXT;
-- Напоминание тем, кто начал настройку и не включил подписку, уже отправлено (index.js nudgeSubscribers).
-- Старым строкам не напоминаем: у них setup пуст, и неизвестно, кто из них остановил подписку сам.
ALTER TABLE subscribers ADD COLUMN nudged INTEGER NOT NULL DEFAULT 0;

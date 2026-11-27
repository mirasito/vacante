-- Воронка формы размещения на сайте и в приложении (2026-11-27, app/src/employer/PostForm.tsx, bot/src/webpost.js):
-- сколько раз за день форму открыли, разобрали вставленный текст, проверили оформление, завели черновик и отправили,
-- по тому, откуда пришли. Только числа: ни работодателя, ни его устройства здесь нет
CREATE TABLE form_events (
  day TEXT NOT NULL,          -- по времени Казахстана (UTC+5)
  came_from TEXT NOT NULL,    -- та же метка, что потом в jobs.came_from: web_<from> или web
  via TEXT NOT NULL,          -- источник визита на сайт (google, chatgpt, tg, direct и другие), '' если неизвестен
  step TEXT NOT NULL,         -- open, parse, tidy, draft, submit
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, came_from, via, step)
);

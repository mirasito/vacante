-- Нажатия по вакансиям (server/src/go.ts): какие вакансии и работодатели получают контакты через vacante
-- и из какого источника пришёл человек. contact_clicks (0015) считает прямые кнопки связи только по дню,
-- месту кнопки и виду и остаётся как есть. Здесь то же нажатие человека записано ещё и по вакансии, а рядом —
-- переходы, которых сервер раньше не видел: на hh.kz, OLX, исходный пост, в бота и в приложение.
-- О человеке здесь ничего нет: только число за день. Нажатия роботов и превью сюда не пишутся.
-- CHECK на kind нет намеренно: новый вид не должен требовать пересборки таблицы (так было с contact_clicks
-- в 0023). Виды проверяет код.
CREATE TABLE vacancy_clicks (
  day TEXT NOT NULL,                 -- день по времени Казахстана, как contact_clicks.day
  vacancy_id TEXT NOT NULL,          -- id вакансии на сайте (vacante.kz/v/<id>/)
  kind TEXT NOT NULL,                -- wa, call, tg, miss (через /go/); hh, olx, orig, app, pf, bot, take (маячок /hit и приложение)
  via TEXT NOT NULL DEFAULT '',      -- источник визита на сайт (chatgpt, google, tg, direct, …) или метка запуска приложения; '' — неизвестен
  source TEXT NOT NULL DEFAULT '',   -- где была кнопка: web, tg, bot, app
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, vacancy_id, kind, via, source)
);

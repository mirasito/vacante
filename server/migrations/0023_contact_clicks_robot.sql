-- Нажатия кнопок связи: новый вид robot — посетитель за день открыл кнопки у слишком многих разных вакансий
-- (обход сайта программой под видом браузера, server/src/go.ts RobotGuard). В sqlite CHECK не поменять,
-- поэтому таблица пересоздаётся с теми же данными.
CREATE TABLE contact_clicks_new (
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('wa', 'call', 'tg', 'miss', 'robot')),
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, kind)
);
INSERT INTO contact_clicks_new (day, source, kind, n) SELECT day, source, kind, n FROM contact_clicks;
DROP TABLE contact_clicks;
ALTER TABLE contact_clicks_new RENAME TO contact_clicks;

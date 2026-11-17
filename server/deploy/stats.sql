-- Сводка по соискателям для workflow «Статистика»: только числа, без имён, телефонов и id.
-- База открывается только на чтение (sqlite3 -readonly). Дни — по времени Казахстана (UTC+5).
-- Начало периода — :since (ГГГГ-ММ-ДД): workflow заменяет его на дату в кавычках.
.headers on
.mode column
CREATE TEMP TABLE t AS SELECT strftime('%Y-%m-%dT%H:%M:%SZ', :since || 'T00:00:00', '-5 hours') AS cut;
-- Похожие на тестовые: проверка выкладки (smoke.py) и имена «тест/test»
CREATE TEMP VIEW testers AS
  SELECT s.id FROM seekers s LEFT JOIN profiles p ON p.seeker_id = s.id
  WHERE s.id = 9007199254740991
     OR lower(s.first_name) LIKE '%test%' OR s.first_name LIKE '%тест%' OR s.first_name LIKE '%Тест%'
     OR lower(coalesce(p.name, '')) LIKE '%test%' OR coalesce(p.name, '') LIKE '%тест%' OR coalesce(p.name, '') LIKE '%Тест%';
CREATE TEMP VIEW prof AS
  SELECT s.id, date(s.created_at, '+5 hours') AS day, s.created_at FROM seekers s
  WHERE EXISTS (SELECT 1 FROM profiles p WHERE p.seeker_id = s.id) AND s.id NOT IN (SELECT id FROM testers);
CREATE TEMP VIEW sent AS
  SELECT a.seeker_id, date(a.sent_at, '+5 hours') AS day, a.sent_at, a.method, a.with_link FROM applications a
  WHERE a.sent_at IS NOT NULL AND a.sent_at >= (SELECT cut FROM t) AND a.seeker_id NOT IN (SELECT id FROM testers);

SELECT 'период с' AS what, :since AS n
UNION ALL SELECT 'тестовых аккаунтов исключено', (SELECT COUNT(*) FROM testers)
UNION ALL SELECT 'профилей всего (без тестовых)', (SELECT COUNT(*) FROM prof)
UNION ALL SELECT 'профилей создано за период', (SELECT COUNT(*) FROM prof WHERE created_at >= (SELECT cut FROM t))
UNION ALL SELECT 'откликов за период', (SELECT COUNT(*) FROM sent)
UNION ALL SELECT 'откликов со ссылкой на профиль', (SELECT COUNT(*) FROM sent WHERE with_link = 1)
UNION ALL SELECT 'людей с откликами за период', (SELECT COUNT(DISTINCT seeker_id) FROM sent)
UNION ALL SELECT 'из них с профилем', (SELECT COUNT(DISTINCT seeker_id) FROM sent WHERE seeker_id IN (SELECT id FROM prof))
UNION ALL SELECT 'из них профиль создан за период', (SELECT COUNT(DISTINCT seeker_id) FROM sent WHERE seeker_id IN (SELECT id FROM prof WHERE created_at >= (SELECT cut FROM t)))
UNION ALL SELECT 'новых профилей без откликов', (SELECT COUNT(*) FROM prof WHERE created_at >= (SELECT cut FROM t) AND id NOT IN (SELECT seeker_id FROM sent))
UNION ALL SELECT 'откликов без профиля (обезличенно, sent_plain)', (SELECT coalesce(SUM(n), 0) FROM funnel_counts WHERE step = 'sent_plain' AND day >= :since)
UNION ALL SELECT 'открытий приложения (сумма по дням)', (SELECT coalesce(SUM(n), 0) FROM funnel_counts WHERE step = 'open' AND day >= :since)
UNION ALL SELECT 'начали анкету (сумма по дням)', (SELECT coalesce(SUM(n), 0) FROM funnel_counts WHERE step = 'profile_start' AND day >= :since);

SELECT '--- по дням ---' AS '';
WITH days(day) AS (SELECT :since UNION ALL SELECT date(day, '+1 day') FROM days WHERE day < date('now', '+5 hours') AND day < date(:since, '+400 days'))
SELECT d.day,
  (SELECT COUNT(*) FROM prof WHERE prof.day = d.day) AS profiles,
  (SELECT COUNT(*) FROM sent WHERE sent.day = d.day) AS applications,
  (SELECT COUNT(DISTINCT seeker_id) FROM sent WHERE sent.day = d.day) AS people_applied,
  (SELECT coalesce(SUM(n), 0) FROM funnel_counts f WHERE f.step = 'sent_plain' AND f.day = d.day) AS plain,
  (SELECT coalesce(SUM(n), 0) FROM funnel_counts f WHERE f.step = 'open' AND f.day = d.day) AS opened
FROM days d;

SELECT '--- откликов на человека ---' AS '';
SELECT n AS applications_per_person, COUNT(*) AS people FROM (SELECT seeker_id, COUNT(*) AS n FROM sent GROUP BY seeker_id) GROUP BY n ORDER BY n;

SELECT '--- способ отклика ---' AS '';
SELECT coalesce(method, '—') AS method, COUNT(*) AS n FROM sent GROUP BY 1 ORDER BY 2 DESC;

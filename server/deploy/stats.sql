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

SELECT '--- профили: что заполнено (без тестовых, все) ---' AS '';
SELECT 'всего' AS what, COUNT(*) AS n FROM prof
UNION ALL SELECT 'короткая анкета (опыт не указан)', (SELECT COUNT(*) FROM profiles p WHERE p.seeker_id IN (SELECT id FROM prof) AND p.experience IS NULL)
UNION ALL SELECT 'с телефоном', (SELECT COUNT(*) FROM profiles p WHERE p.seeker_id IN (SELECT id FROM prof) AND p.phone IS NOT NULL)
UNION ALL SELECT 'с фото', (SELECT COUNT(*) FROM photos f WHERE f.seeker_id IN (SELECT id FROM prof))
UNION ALL SELECT 'с кружком', (SELECT COUNT(*) FROM videos v WHERE v.seeker_id IN (SELECT id FROM prof))
UNION ALL SELECT 'с домом', (SELECT COUNT(*) FROM profiles p WHERE p.seeker_id IN (SELECT id FROM prof) AND p.home_lat IS NOT NULL)
UNION ALL SELECT 'с «о себе»', (SELECT COUNT(*) FROM profiles p WHERE p.seeker_id IN (SELECT id FROM prof) AND p.about IS NOT NULL)
UNION ALL SELECT 'в базе для работодателей', (SELECT COUNT(*) FROM seekers s WHERE s.id IN (SELECT id FROM prof) AND s.base_consent_at IS NOT NULL)
UNION ALL SELECT 'разрешили боту писать', (SELECT COUNT(*) FROM seekers s WHERE s.id IN (SELECT id FROM prof) AND s.write_access = 1)
UNION ALL SELECT 'язык kk', (SELECT COUNT(*) FROM seekers s WHERE s.id IN (SELECT id FROM prof) AND s.lang = 'kk')
UNION ALL SELECT 'заходили после дня создания', (SELECT COUNT(*) FROM seekers s WHERE s.id IN (SELECT id FROM prof) AND date(s.seen_at, '+5 hours') > date(s.created_at, '+5 hours'))
UNION ALL SELECT 'делились общей ссылкой на профиль', (SELECT COUNT(DISTINCT seeker_id) FROM links WHERE application_id IS NULL AND seeker_id IN (SELECT id FROM prof));

SELECT '--- источник профилей ---' AS '';
SELECT coalesce(source, '—') AS source, COUNT(*) AS n FROM seekers WHERE id IN (SELECT id FROM prof) GROUP BY 1 ORDER BY 2 DESC;

SELECT '--- работодатели и профили ---' AS '';
SELECT 'просмотров профилей всего' AS what, (SELECT COUNT(*) FROM views WHERE seeker_id IN (SELECT id FROM prof)) AS n
UNION ALL SELECT 'из них по ссылке отклика', (SELECT COUNT(*) FROM views WHERE application_id IS NOT NULL AND seeker_id IN (SELECT id FROM prof))
UNION ALL SELECT 'из них по общей ссылке', (SELECT COUNT(*) FROM views WHERE application_id IS NULL AND seeker_id IN (SELECT id FROM prof))
UNION ALL SELECT 'чьи профили открывали (людей)', (SELECT COUNT(DISTINCT seeker_id) FROM views WHERE seeker_id IN (SELECT id FROM prof))
UNION ALL SELECT 'откликов, чью ссылку открыли', (SELECT COUNT(DISTINCT application_id) FROM views WHERE application_id IS NOT NULL)
UNION ALL SELECT 'нажали «Показать телефон»', (SELECT COUNT(*) FROM views WHERE phone_shown = 1)
UNION ALL SELECT 'ответов работодателя (приглашение/отказ)', (SELECT COUNT(*) FROM application_events WHERE by = 'employer' AND stage != 'seen')
UNION ALL SELECT 'нажатий «разместить вакансию» со страницы профиля', (SELECT coalesce(SUM(n), 0) FROM post_clicks);

SELECT '--- отклики по этапам и со ссылкой (все, без тестовых) ---' AS '';
SELECT a.stage, a.with_link, coalesce(a.method, '—') AS method, COUNT(*) AS n FROM applications a
WHERE a.sent_at IS NOT NULL AND a.seeker_id NOT IN (SELECT id FROM testers) GROUP BY 1, 2, 3 ORDER BY 4 DESC;

SELECT '--- шаги полной анкеты с периода ---' AS '';
SELECT screen, SUM(reached) AS reached, SUM(passed) AS passed FROM funnel_form WHERE day >= :since GROUP BY screen;

SELECT '--- прямые кнопки связи с периода ---' AS '';
SELECT source, kind, SUM(n) AS n FROM contact_clicks WHERE day >= :since GROUP BY 1, 2 ORDER BY 3 DESC;

SELECT '--- воронка по источникам с периода (метка из ссылки запуска; пусто — без метки) ---' AS '';
SELECT coalesce(nullif(source, ''), '—') AS source,
  SUM(CASE WHEN step = 'open' THEN n ELSE 0 END) AS opened,
  SUM(CASE WHEN step = 'profile_start' THEN n ELSE 0 END) AS profile_start,
  SUM(CASE WHEN step = 'sent_plain' THEN n ELSE 0 END) AS sent_plain
FROM funnel_counts WHERE day >= :since GROUP BY 1 ORDER BY 2 DESC;

SELECT '--- открытия по дням и источникам ---' AS '';
SELECT day, coalesce(nullif(source, ''), '—') AS source, n FROM funnel_counts
WHERE step = 'open' AND day >= :since ORDER BY day, n DESC;

SELECT '--- повторные открытия по источникам (сколько открытий от уже открывавших) ---' AS '';
SELECT coalesce(nullif(source, ''), '—') AS source, SUM(n) AS returns FROM funnel_returns WHERE day >= :since GROUP BY 1 ORDER BY 2 DESC;

SELECT '--- профили и отклики за период по источнику человека ---' AS '';
SELECT coalesce(s.source, '—') AS source,
  (SELECT COUNT(*) FROM prof p JOIN seekers x ON x.id = p.id WHERE coalesce(x.source, '—') = coalesce(s.source, '—') AND p.created_at >= (SELECT cut FROM t)) AS profiles,
  COUNT(a.seeker_id) AS applications, COUNT(DISTINCT a.seeker_id) AS people
FROM seekers s LEFT JOIN sent a ON a.seeker_id = s.id
WHERE s.id IN (SELECT id FROM prof) GROUP BY 1 ORDER BY 3 DESC, 2 DESC;

SELECT '--- прямые кнопки связи по дням ---' AS '';
SELECT day, SUM(n) AS n FROM contact_clicks WHERE day >= :since GROUP BY 1 ORDER BY 1;

SELECT '--- входы в админку по дням (без адресов) ---' AS '';
SELECT date(at, '+5 hours') AS day, result, COUNT(*) AS n, COUNT(DISTINCT ip) AS addresses FROM admin_logins
WHERE at >= (SELECT cut FROM t) GROUP BY 1, 2 ORDER BY 1, 2;

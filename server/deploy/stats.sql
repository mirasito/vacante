-- Сводка по соискателям для workflow «Статистика»: только числа, без имён, телефонов и id.
-- В конце — нажатия по вакансиям: там есть названия работодателей и вакансий из открытых объявлений (CRM).
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

SELECT '--- прямые кнопки связи по дням (people — люди, robot — обход роботом под видом браузера) ---' AS '';
SELECT day, SUM(CASE WHEN kind = 'robot' THEN 0 ELSE n END) AS people, SUM(CASE WHEN kind = 'robot' THEN n ELSE 0 END) AS robot
FROM contact_clicks WHERE day >= :since GROUP BY 1 ORDER BY 1;

SELECT '--- входы в админку по дням (без адресов) ---' AS '';
SELECT date(at, '+5 hours') AS day, result, COUNT(*) AS n, COUNT(DISTINCT ip) AS addresses FROM admin_logins
WHERE at >= (SELECT cut FROM t) GROUP BY 1, 2 ORDER BY 1, 2;

-- Дальше — нажатия по вакансиям (vacancy_clicks, миграция 0024). Эти разделы стоят в самом конце: на базе,
-- где миграции ещё нет, они дадут ошибку «no such table», а всё, что выше, уже напечатано.

SELECT '--- North Star по неделям (week — понедельник недели; days — сколько её дней попало в период) ---' AS '';
-- North Star: сколько раз за неделю человек через vacante дошёл до работодателя или до его объявления.
--   site_direct — прямые кнопки связи «WhatsApp», «Позвонить», «Telegram» (contact_clicks: wa + call + tg);
--   site_out    — переходы с сайта на hh.kz, OLX и исходный пост, «Откликнуться в Telegram» и «Беру смену»
--                 (vacancy_clicks: hh, olx, orig, bot, take; до миграции 0024 они не считались);
--   app_sent    — отклики из приложения: с профилем (applications, без тестовых) и без профиля
--                 (funnel_counts, шаг sent_plain: один на человека в день);
--   north_star  = site_direct + site_out + app_sent.
-- Не входят: to_app — переходы с сайта в приложение (app, pf): показаны рядом, но не прибавлены, потому что
-- отклик, сделанный в приложении, уже есть в app_sent; miss (контакта в посте не нашлось) и robot; отклики
-- в боте на вакансии самих работодателей — они лежат в базе бота (D1), их показывает bot_stats.py.
WITH days(day) AS (SELECT :since UNION ALL SELECT date(day, '+1 day') FROM days WHERE day < date('now', '+5 hours') AND day < date(:since, '+400 days')),
weeks AS (SELECT date(day, 'weekday 0', '-6 days') AS week, MIN(day) AS first_day, MAX(day) AS last_day, COUNT(*) AS days FROM days GROUP BY 1)
SELECT week, days, site_direct, site_out, app_sent, site_direct + site_out + app_sent AS north_star, to_app FROM (
  SELECT w.week, w.days,
    (SELECT coalesce(SUM(n), 0) FROM contact_clicks c WHERE c.day BETWEEN w.first_day AND w.last_day AND c.kind IN ('wa', 'call', 'tg')) AS site_direct,
    (SELECT coalesce(SUM(n), 0) FROM vacancy_clicks c WHERE c.day BETWEEN w.first_day AND w.last_day
       AND c.kind IN ('hh', 'olx', 'orig', 'bot', 'take') AND c.source <> 'app') AS site_out,
    (SELECT COUNT(*) FROM sent s WHERE s.day BETWEEN w.first_day AND w.last_day)
      + (SELECT coalesce(SUM(n), 0) FROM funnel_counts f WHERE f.day BETWEEN w.first_day AND w.last_day AND f.step = 'sent_plain') AS app_sent,
    (SELECT coalesce(SUM(n), 0) FROM vacancy_clicks c WHERE c.day BETWEEN w.first_day AND w.last_day AND c.kind IN ('app', 'pf')) AS to_app
  FROM weeks w
) ORDER BY week;

SELECT '--- нажатия по источнику визита с периода (кнопки сайта; via — откуда человек пришёл на сайт; total — без miss) ---' AS '';
SELECT coalesce(nullif(via, ''), '—') AS via,
  SUM(CASE WHEN kind <> 'miss' THEN n ELSE 0 END) AS total,
  SUM(CASE WHEN kind = 'wa' THEN n ELSE 0 END) AS wa,
  SUM(CASE WHEN kind = 'call' THEN n ELSE 0 END) AS call,
  SUM(CASE WHEN kind = 'tg' THEN n ELSE 0 END) AS tg,
  SUM(CASE WHEN kind = 'hh' THEN n ELSE 0 END) AS hh,
  SUM(CASE WHEN kind = 'olx' THEN n ELSE 0 END) AS olx,
  SUM(CASE WHEN kind = 'orig' THEN n ELSE 0 END) AS orig,
  SUM(CASE WHEN kind = 'bot' THEN n ELSE 0 END) AS bot,
  SUM(CASE WHEN kind = 'take' THEN n ELSE 0 END) AS take,
  SUM(CASE WHEN kind = 'app' THEN n ELSE 0 END) AS app,
  SUM(CASE WHEN kind = 'pf' THEN n ELSE 0 END) AS pf,
  SUM(CASE WHEN kind = 'miss' THEN n ELSE 0 END) AS miss
FROM vacancy_clicks WHERE day >= :since AND source = 'web' GROUP BY 1 ORDER BY 2 DESC, 1;

-- Контакты по вакансиям из трёх мест в одном виде: нажатия на сайте и отклики без профиля из приложения
-- (vacancy_clicks; miss не берём: контакта не нашлось) и отклики с профилем (applications, без тестовых:
-- способ отклика переведён в тот же вид, with_profile = 1). Отклики с профилем добавлены, чтобы в списки
-- попадали и вакансии, на которые откликаются из каналов: там кнопка ведёт сразу в приложение, мимо сайта.
CREATE TEMP VIEW touches AS
  SELECT day, vacancy_id, kind, n, 0 AS with_profile FROM vacancy_clicks WHERE kind <> 'miss'
  UNION ALL
  SELECT date(a.sent_at, '+5 hours'), a.vacancy_id,
    CASE a.method WHEN 'whatsapp' THEN 'wa' WHEN 'telegram' THEN 'tg' WHEN 'call' THEN 'call' WHEN 'hh' THEN 'hh' WHEN 'bot' THEN 'bot' ELSE 'orig' END,
    1, 1
  FROM applications a WHERE a.sent_at IS NOT NULL AND a.seeker_id NOT IN (SELECT id FROM testers);
-- Вакансия → заведение и работодатель из CRM. Названия — с ручными правками из админки (edits), как в карточке
CREATE TEMP VIEW known AS
  SELECT v.id AS vacancy_id, v.title, e.id AS employer_id, e.status,
    coalesce(nullif(CASE WHEN json_valid(e.edits) THEN json_extract(e.edits, '$.name') END, ''), e.name) AS employer,
    coalesce(nullif(CASE WHEN json_valid(p.edits) THEN json_extract(p.edits, '$.name') END, ''), p.name) AS venue
  FROM employer_vacancies v JOIN venues p ON p.id = v.venue_id JOIN employers e ON e.id = p.employer_id;

SELECT '--- топ-30 вакансий по контактам за 7 дней (total = direct + out + to_app; with_profile — из них отклики с профилем) ---' AS '';
-- direct — написали или позвонили работодателю напрямую (wa, call, tg); out — ушли к его объявлению на hh.kz,
-- OLX, в исходный пост или в бота (hh, olx, orig, bot, take); to_app — перешли с сайта в приложение (app, pf).
-- «—» вместо названий — вакансии нет в CRM.
SELECT x.vacancy_id,
  SUM(x.n) AS total,
  SUM(CASE WHEN x.kind IN ('wa', 'call', 'tg') THEN x.n ELSE 0 END) AS direct,
  SUM(CASE WHEN x.kind IN ('hh', 'olx', 'orig', 'bot', 'take') THEN x.n ELSE 0 END) AS out,
  SUM(CASE WHEN x.kind IN ('app', 'pf') THEN x.n ELSE 0 END) AS to_app,
  SUM(x.n * x.with_profile) AS with_profile,
  coalesce(substr(k.title, 1, 40), '—') AS title,
  coalesce(substr(k.employer, 1, 40), '—') AS employer,
  coalesce(substr(k.venue, 1, 40), '—') AS venue
FROM touches x LEFT JOIN known k ON k.vacancy_id = x.vacancy_id
WHERE x.day >= date('now', '+5 hours', '-6 days')
GROUP BY x.vacancy_id ORDER BY total DESC, x.vacancy_id LIMIT 30;

SELECT '--- топ-30 работодателей по контактам за 14 дней (те же столбцы; только вакансии, которые есть в CRM) ---' AS '';
-- Кому из работодателей звонить первым: direct — число для разговора «через vacante вам написали или
-- позвонили N раз». vacancies — у скольких его вакансий были контакты; crm — статус работодателя в CRM.
SELECT substr(k.employer, 1, 40) AS employer,
  CASE k.status WHEN '' THEN '—' ELSE k.status END AS crm,
  COUNT(DISTINCT x.vacancy_id) AS vacancies,
  SUM(x.n) AS total,
  SUM(CASE WHEN x.kind IN ('wa', 'call', 'tg') THEN x.n ELSE 0 END) AS direct,
  SUM(CASE WHEN x.kind IN ('hh', 'olx', 'orig', 'bot', 'take') THEN x.n ELSE 0 END) AS out,
  SUM(CASE WHEN x.kind IN ('app', 'pf') THEN x.n ELSE 0 END) AS to_app,
  SUM(x.n * x.with_profile) AS with_profile
FROM touches x JOIN known k ON k.vacancy_id = x.vacancy_id
WHERE x.day >= date('now', '+5 hours', '-13 days')
GROUP BY k.employer_id ORDER BY total DESC, k.employer_id LIMIT 30;

SELECT '--- возвраты в приложение с периода: сколько дней прошло с прошлого открытия (давнее 90 дней не хранится) ---' AS '';
WITH buckets(ord, gap, lo, hi) AS (VALUES (1, '1 день', 1, 1), (2, '2–3 дня', 2, 3), (3, '4–7 дней', 4, 7), (4, '8–30 дней', 8, 30), (5, '31–90 дней', 31, 90))
SELECT b.gap, coalesce(SUM(r.n), 0) AS returns
FROM buckets b LEFT JOIN funnel_returns r ON r.gap BETWEEN b.lo AND b.hi AND r.day >= :since
GROUP BY b.ord ORDER BY b.ord;

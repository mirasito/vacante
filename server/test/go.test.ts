// Прямые кнопки связи: /go/<вакансия>/<wa|call|tg> сразу ведёт в WhatsApp, на звонок или в Telegram.
// Нажатия по вакансиям: те же кнопки с источником визита (via) и маячок сайта POST /hit.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { backfillContacts, COUNTS_PER_MINUTE, HIT_VACANCIES, LABELS_PER_DAY, RobotGuard, VACANCIES_PER_DAY } from "../src/go.ts";
import { BROWSER, count, startServer, type TestServer } from "./helpers.ts";

const KEY = "ab".repeat(32);
const admin = { authorization: `Bearer ${KEY}` };

/** Страница поста на t.me так, как её отдаёт ?embed=1. */
const embed = (channel: string, id: number, text: string) =>
  `<!DOCTYPE html><html><body class="body_widget_post"><div class="tgme_widget_message_wrap js-widget_message_wrap">` +
  `<div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="${channel}/${id}" data-view="x">` +
  `<div class="tgme_widget_message_user"><a href="https://t.me/${channel}"></a></div><div class="tgme_widget_message_bubble">` +
  `<div class="tgme_widget_message_author accent_color"><a class="tgme_widget_message_owner_name" href="https://t.me/${channel}">` +
  `<span dir="auto">Работа Алматы</span></a></div>` +
  `<div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div>` +
  `<div class="tgme_widget_message_footer compact js-message_footer"><a class="tgme_widget_message_date" href="https://t.me/${channel}/${id}">` +
  `<time datetime="2026-11-04T05:00:00+00:00" class="time">10:00</time></a></div></div></div></div></body></html>`;

const POST = embed(
  "almatyrabota1",
  21258,
  "Требуется бариста в кофейню «Зерно»<br/>WhatsApp: 8 701 123 45 67<br/>" +
    'Резюме: <a href="https://t.me/hr_zerno" target="_blank">@hr_zerno</a>',
);
const NO_CONTACTS = embed("almatyrabota1", 21300, "Требуется повар, подробности на собеседовании");

const started: TestServer[] = [];
after(async () => {
  for (const s of started) await s.close().catch(() => undefined);
});

/** Сервер, который вместо t.me читает страницы из pages; fetched — что он запрашивал. */
async function server(pages: Record<string, string> = { "almatyrabota1/21258": POST, "almatyrabota1/21300": NO_CONTACTS }) {
  const fetched: string[] = [];
  let clock = Date.parse("2026-11-04T06:00:00Z");
  const fetchImpl = (async (url: string | URL) => {
    const href = String(url);
    fetched.push(href);
    const m = /^https:\/\/t\.me\/([^/]+\/\d+)\?/.exec(href);
    const page = m ? pages[m[1]!] : undefined;
    return page ? new Response(page) : new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  const s = await startServer({ fetch: fetchImpl, now: () => clock }, { CRM_KEY: KEY });
  started.push(s);
  // Кнопки нажимает человек из браузера; роботов проверяет отдельный тест
  const call = s.call.bind(s);
  s.call = (method, path, opts = {}) => call(method, path, { ...opts, headers: { "user-agent": BROWSER, ...opts.headers } });
  return { s, fetched, fetchImpl, tick: (ms: number) => void (clock += ms) };
}

const DAY = 24 * 3_600_000;

/** Нажатия по вакансиям, как они лежат в базе. */
const clicks = (s: TestServer, where = "1 = 1") =>
  s.db
    .prepare(`SELECT day, vacancy_id, kind, via, source, n FROM vacancy_clicks WHERE ${where} ORDER BY day, vacancy_id, kind, via, source`)
    .all()
    .map((r) => ({ ...r }));

/** Маячок так, как его шлёт страница сайта через navigator.sendBeacon: JSON простым текстом, без предварительного запроса. */
const beacon = (s: TestServer, body: unknown, headers: Record<string, string> = {}) =>
  s.call("POST", "/hit", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "text/plain;charset=UTF-8", origin: "https://vacante.kz", ...headers },
  });

test("WhatsApp: сразу в чат с номером из поста и готовым текстом; номер сохраняется на сервере", async () => {
  const { s, fetched } = await server();
  const r = await s.call("GET", "/go/almatyrabota1-21258/wa?s=web&t=" + encodeURIComponent("Бариста"));
  assert.equal(r.status, 302);
  const to = new URL(String(r.headers.location));
  assert.equal(to.origin + to.pathname, "https://wa.me/77011234567");
  assert.equal(to.searchParams.get("text"), "Здравствуйте! Пишу по вакансии «Бариста». Нашёл её на vacante.kz");
  assert.equal(r.headers["x-robots-tag"], "noindex, nofollow");
  assert.deepEqual(
    { ...s.db.prepare("SELECT whatsapp, phone, telegram, found FROM vacancy_contacts WHERE vacancy_id = ?").get("almatyrabota1-21258") },
    { whatsapp: "+77011234567", phone: "+77011234567", telegram: "hr_zerno", found: 1 },
  );
  // Второе нажатие берёт номер из базы, t.me больше не спрашиваем
  await s.call("GET", "/go/almatyrabota1-21258/wa");
  assert.equal(fetched.length, 1);
});

test("Telegram ведёт к работодателю, звонок — на страницу с номером и ссылкой tel:", async () => {
  const { s } = await server();
  const tg = await s.call("GET", "/go/almatyrabota1-21258/tg?s=tg");
  assert.equal(tg.status, 302);
  assert.equal(tg.headers.location, "https://t.me/hr_zerno");
  const call = await s.call("GET", "/go/almatyrabota1-21258/call?s=tg");
  assert.equal(call.status, 200);
  assert.match(call.text, /href="tel:\+77011234567"/);
  assert.match(call.text, /\+7 701 123 45 67/);
  assert.match(call.text, /http-equiv="refresh" content="0;url=tel:\+77011234567"/);
});

test("контакта нет, пост удалён или t.me не ответил: ведём на исходный пост", async () => {
  const { s, fetched } = await server();
  for (const path of ["/go/almatyrabota1-21300/wa", "/go/almatyrabota1-99999/call"]) {
    const r = await s.call("GET", path);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, `https://t.me/${path.split("/")[2]!.replace("-", "/")}`);
  }
  // «Не нашли» тоже помним сутки: повторные нажатия не дёргают t.me
  await s.call("GET", "/go/almatyrabota1-21300/wa");
  assert.equal(fetched.length, 2);
});

test("чужие адреса не открываем: только вакансии из каналов и только три вида связи", async () => {
  const { s, fetched } = await server();
  assert.equal((await s.call("GET", "/go/hh-139501020/wa")).status, 404);
  assert.equal((await s.call("GET", "/go/almatyrabota1-21258/sms")).status, 404);
  assert.equal((await s.call("GET", "/go/..%2F..%2Fetc-1/wa")).status, 404);
  assert.equal(fetched.length, 0);
});

test("текст отклика: название обрезается и чистится, без названия — общий текст", async () => {
  const { s } = await server();
  const text = async (t: string) =>
    new URL(String((await s.call("GET", "/go/almatyrabota1-21258/wa?t=" + encodeURIComponent(t))).headers.location)).searchParams.get("text");
  assert.equal(await text(""), "Здравствуйте! Пишу по вакансии. Нашёл её на vacante.kz");
  assert.equal(await text("Повар\n<script>"), "Здравствуйте! Пишу по вакансии «Повар script». Нашёл её на vacante.kz");
  assert.ok((await text("я".repeat(300)))!.length < 160);
});

test("нажатия считаются по дням, источникам и видам; видны в админке", async () => {
  const { s } = await server();
  await s.call("GET", "/go/almatyrabota1-21258/wa?s=web");
  await s.call("GET", "/go/almatyrabota1-21258/wa?s=web");
  await s.call("GET", "/go/almatyrabota1-21258/call?s=tg");
  await s.call("GET", "/go/almatyrabota1-21300/wa?s=%3Cscript%3E"); // метка не по формату, контакта нет
  const r = await s.call("GET", "/admin/funnel?days=7", { headers: admin });
  assert.deepEqual(r.json.clicks, [
    { day: "2026-11-04", source: "—", kind: "miss", n: 1 },
    { day: "2026-11-04", source: "tg", kind: "call", n: 1 },
    { day: "2026-11-04", source: "web", kind: "wa", n: 2 },
  ]);
});

test("много нажатий по новым вакансиям подряд: лишние идут на исходный пост, t.me не заваливаем", async () => {
  const pages: Record<string, string> = {};
  for (let i = 1; i <= 80; i++) pages[`almatyrabota1/${i}`] = embed("almatyrabota1", i, "Повар, тел 8 701 123 45 67");
  const { s, fetched } = await server(pages);
  let direct = 0;
  for (let i = 1; i <= 80; i++) {
    // Разные люди: с одного адреса столько вакансий подряд открывает только робот (тест ниже)
    const r = await s.call("GET", `/go/almatyrabota1-${i}/wa`, { headers: { "x-forwarded-for": `198.51.100.${i}` } });
    if (String(r.headers.location).startsWith("https://wa.me/")) direct++;
  }
  assert.equal(fetched.length, 60);
  assert.equal(direct, 60);
});

test("фоновый сбор сохраняет номера всех вакансий из каналов, по порции за раз", async () => {
  const pages: Record<string, string> = {};
  for (let i = 1; i <= 5; i++) pages[`almatyrabota1/${i}`] = embed("almatyrabota1", i, `Повар, тел 8 701 123 45 6${i}`);
  const { s, fetched, fetchImpl } = await server(pages);
  s.db.prepare("INSERT INTO employers (id, key, name, first_seen, last_seen) VALUES (1, 'зерно', 'Зерно', '2026-11-01', '2026-11-04')").run();
  s.db.prepare("INSERT INTO venues (id, key, employer_id, name, first_seen, last_seen) VALUES (1, 'almaty:зерно', 1, 'Зерно', '2026-11-01', '2026-11-04')").run();
  const add = s.db.prepare(
    "INSERT INTO employer_vacancies (id, venue_id, title, source, posted_at, first_seen, last_seen, active) VALUES (?, 1, 'Повар', ?, '2026-11-04', '2026-11-04', '2026-11-04', ?)",
  );
  for (let i = 1; i <= 5; i++) add.run(`almatyrabota1-${i}`, "telegram", 1);
  add.run("hh-1", "hh", 1);
  add.run("almatyrabota1-77", "telegram", 0); // снята с сайта
  const deps = { db: s.db, fetch: fetchImpl, now: () => Date.parse("2026-11-04T06:00:00Z") };
  assert.equal(await backfillContacts(deps, 3, 0), 3);
  assert.equal(await backfillContacts(deps, 3, 0), 2);
  assert.equal(await backfillContacts(deps, 3, 0), 0);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM vacancy_contacts WHERE found = 1"), 5);
  assert.equal(fetched.length, 5);
});

test("вилка зарплаты «237000 - 237000 ₸» — не номер работодателя", async () => {
  const { contactsOf } = await import("../src/contacts.ts");
  assert.equal(contactsOf("Повар в кафе\nЗарплата: 237000 - 237000 ₸", [], "almaty_jobs").phone, null);
  assert.equal(contactsOf("Зарплата: 700000 - 700000 ₸\nТел: 87011234567", [], "almaty_jobs").phone, "+77011234567");
});

test("роботы: нажатие не считается, номер не отдаётся, robots.txt закрывает API", async () => {
  const { s, fetched } = await server();
  for (const ua of ["Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)", ""]) {
    const r = await s.call("GET", "/go/almatyrabota1-21258/call?s=web", { headers: { "user-agent": ua } });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "https://t.me/almatyrabota1/21258");
  }
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM contact_clicks"), 0);
  assert.deepEqual(fetched, []);
  const robots = await s.call("GET", "/robots.txt");
  assert.equal(robots.text, "User-agent: *\nDisallow: /\n");
});

test("робот под видом браузера, который обходит все кнопки подряд, считается отдельно и номера не получает", async () => {
  const posts: Record<string, string> = {};
  for (let i = 0; i < 20; i++) posts[`almatyrabota1/${22000 + i}`] = embed("almatyrabota1", 22000 + i, "Нужен грузчик, WhatsApp: 8 701 123 45 67");
  const { s } = await server(posts);
  const robot = { "x-forwarded-for": "203.0.113.7" };
  const statuses: string[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await s.call("GET", `/go/almatyrabota1-${22000 + i}/wa?s=web`, { headers: robot });
    statuses.push(String(r.headers.location).startsWith("https://wa.me/") ? "wa" : "post");
  }
  // Первые 15 разных вакансий — как у человека, дальше ведём на пост без номера
  assert.deepEqual(statuses, [...Array(15).fill("wa"), ...Array(5).fill("post")]);
  // Человек с другого адреса в тот же день получает номер как обычно
  const person = await s.call("GET", "/go/almatyrabota1-22000/wa?s=web", { headers: { "x-forwarded-for": "198.51.100.2" } });
  assert.match(String(person.headers.location), /^https:\/\/wa\.me\//);
  const kinds = Object.fromEntries(
    (s.db.prepare("SELECT kind, n FROM contact_clicks").all() as { kind: string; n: number }[]).map((r) => [r.kind, Number(r.n)]),
  );
  assert.deepEqual(kinds, { wa: 16, robot: 5 });
  // Тот же человек много раз открывает одну вакансию — это не обход
  for (let i = 0; i < 30; i++) await s.call("GET", "/go/almatyrabota1-22001/wa", { headers: { "x-forwarded-for": "198.51.100.3" } });
  assert.equal((s.db.prepare("SELECT n FROM contact_clicks WHERE kind = 'robot'").get() as { n: number }).n, 5);
});

test("нажатие человека пишется ещё и по вакансии, с источником визита из ссылки (via)", async () => {
  const { s } = await server();
  const first = await s.call("GET", "/go/almatyrabota1-21258/wa?s=web&via=chatgpt&t=" + encodeURIComponent("Бариста"));
  // Сам переход от метки не меняется
  assert.equal(first.status, 302);
  assert.match(String(first.headers.location), /^https:\/\/wa\.me\/77011234567\?text=/);
  await s.call("GET", "/go/almatyrabota1-21258/wa?s=web&via=chatgpt");
  await s.call("GET", "/go/almatyrabota1-21258/call?s=web&via=google");
  await s.call("GET", "/go/almatyrabota1-21258/tg?s=tg"); // ссылка без via: страница из кэша или старая ссылка
  await s.call("GET", "/go/almatyrabota1-21258/wa?s=web&via=" + encodeURIComponent("Chat GPT<script>")); // via не по формату
  await s.call("GET", "/go/almatyrabota1-21300/wa?s=web&via=direct"); // контакта нет: человек ушёл на пост
  assert.deepEqual(clicks(s), [
    { day: "2026-11-04", vacancy_id: "almatyrabota1-21258", kind: "call", via: "google", source: "web", n: 1 },
    { day: "2026-11-04", vacancy_id: "almatyrabota1-21258", kind: "tg", via: "", source: "tg", n: 1 },
    { day: "2026-11-04", vacancy_id: "almatyrabota1-21258", kind: "wa", via: "", source: "web", n: 1 },
    { day: "2026-11-04", vacancy_id: "almatyrabota1-21258", kind: "wa", via: "chatgpt", source: "web", n: 2 },
    { day: "2026-11-04", vacancy_id: "almatyrabota1-21300", kind: "miss", via: "direct", source: "web", n: 1 },
  ]);
  // Общий счётчик по дням, источникам и видам считает те же нажатия, как раньше
  assert.deepEqual(
    s.db.prepare("SELECT source, kind, n FROM contact_clicks ORDER BY source, kind").all().map((r) => ({ ...r })),
    [
      { source: "tg", kind: "tg", n: 1 },
      { source: "web", kind: "call", n: 1 },
      { source: "web", kind: "miss", n: 1 },
      { source: "web", kind: "wa", n: 3 },
    ],
  );
});

test("нажатия роботов и превью по вакансиям не пишутся", async () => {
  const posts: Record<string, string> = {};
  for (let i = 0; i < 20; i++) posts[`almatyrabota1/${22000 + i}`] = embed("almatyrabota1", 22000 + i, "Нужен грузчик, WhatsApp: 8 701 123 45 67");
  const { s } = await server(posts);
  for (const ua of ["Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)", "TelegramBot (like TwitterBot)", ""]) {
    await s.call("GET", "/go/almatyrabota1-22000/wa?s=web&via=google", { headers: { "user-agent": ua } });
  }
  assert.deepEqual(clicks(s), []);
  // Робот под видом браузера: первые 15 вакансий — как у человека, остальные идут только в общее число robot
  const robot = { "x-forwarded-for": "203.0.113.7" };
  for (let i = 0; i < 20; i++) await s.call("GET", `/go/almatyrabota1-${22000 + i}/wa?s=web&via=google`, { headers: robot });
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM vacancy_clicks"), 15);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM vacancy_clicks WHERE vacancy_id >= 'almatyrabota1-22015'"), 0);
  assert.equal(count(s, "SELECT n FROM contact_clicks WHERE kind = 'robot'"), 5);
});

test("маячок /hit считает переходы с сайта по вакансии, виду и источнику визита", async () => {
  const { s } = await server();
  for (const kind of ["hh", "olx", "orig", "app", "pf", "bot", "take"]) {
    const r = await beacon(s, { id: "hh-139501020", kind, via: "chatgpt", s: "web" });
    assert.equal(r.status, 204, kind);
    assert.equal(r.text, "");
    assert.equal(r.headers["set-cookie"], undefined);
  }
  await beacon(s, { id: "hh-139501020", kind: "hh", via: "chatgpt", s: "web" }); // ещё один переход того же вида
  await beacon(s, { id: "olx-77", kind: "olx" }); // без меток: кнопка на сайте, источник визита неизвестен
  await beacon(s, { id: "bot-15", kind: "take", via: "Chat GPT", s: "<b>" }); // метки не по формату переход не отменяют
  const row = (vacancy_id: string, kind: string, via: string, source: string, n: number) => ({ day: "2026-11-04", vacancy_id, kind, via, source, n });
  assert.deepEqual(clicks(s), [
    row("bot-15", "take", "", "", 1),
    row("hh-139501020", "app", "chatgpt", "web", 1),
    row("hh-139501020", "bot", "chatgpt", "web", 1),
    row("hh-139501020", "hh", "chatgpt", "web", 2),
    row("hh-139501020", "olx", "chatgpt", "web", 1),
    row("hh-139501020", "orig", "chatgpt", "web", 1),
    row("hh-139501020", "pf", "chatgpt", "web", 1),
    row("hh-139501020", "take", "chatgpt", "web", 1),
    row("olx-77", "olx", "", "web", 1),
  ]);
  // Общий счётчик прямых кнопок маячок не трогает
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM contact_clicks"), 0);
});

test("маячок: тело не по формату — 400, в базу ничего не попадает", async () => {
  const { s } = await server();
  const bad = [
    "",
    "не json",
    "null",
    "[]",
    '"hh-139501020"',
    {},
    { id: "hh-139501020" },
    { kind: "hh" },
    { id: "hh", kind: "hh" },
    { id: "hh 139501020", kind: "hh" },
    { id: "../../etc", kind: "hh" },
    { id: "a".repeat(65), kind: "hh" },
    { id: 139501020, kind: "hh" },
    { id: "hh-139501020", kind: "sms" },
    { id: "hh-139501020", kind: ["hh"] },
    // Прямые кнопки сервер считает сам на переходе /go/…: маячком их не прислать
    { id: "almatyrabota1-21258", kind: "wa" },
    { id: "almatyrabota1-21258", kind: "miss" },
    { id: "almatyrabota1-21258", kind: "robot" },
  ];
  for (const body of bad) assert.equal((await beacon(s, body)).status, 400, JSON.stringify(body));
  assert.deepEqual(clicks(s), []);
  assert.equal((await s.call("GET", "/hit")).status, 405);
});

test("маячок с чужого сайта и от роботов не считается, но и ошибкой не отвечает", async () => {
  const { s } = await server();
  const hit = { id: "hh-139501020", kind: "hh", via: "google", s: "web" };
  const ignored: Record<string, string>[] = [
    { origin: "https://evil.example" },
    { origin: "https://vacante.kz.evil.example" },
    { origin: "null" },
    { "user-agent": "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)" },
    { "user-agent": "python-requests/2.32" },
    { "user-agent": "" },
  ];
  for (const headers of ignored) {
    const r = await beacon(s, hit, headers);
    assert.equal(r.status, 204, JSON.stringify(headers));
    assert.equal(r.text, "");
  }
  assert.deepEqual(clicks(s), []);
  // Запрос без Origin не от браузера: браузер ставит Origin на любой POST с другого адреса, sendBeacon тоже
  const bare = await s.call("POST", "/hit", { body: JSON.stringify(hit), headers: { "content-type": "text/plain;charset=UTF-8" } });
  assert.equal(bare.status, 204);
  assert.deepEqual(clicks(s), []);
  // Свой сайт (оба адреса) считается
  await beacon(s, hit);
  await beacon(s, hit, { origin: "https://www.vacante.kz" });
  assert.deepEqual(clicks(s), [{ day: "2026-11-04", vacancy_id: "hh-139501020", kind: "hh", via: "google", source: "web", n: 2 }]);
});

test("маячок: от одного посетителя за день считается не больше 60 разных вакансий; кнопки связи от этого не зависят", async () => {
  const { s, tick } = await server();
  const visitor = { "x-forwarded-for": "203.0.113.7" };
  for (let i = 1; i <= HIT_VACANCIES + 5; i++) {
    // Что видит человек, не меняется: ответ тот же, переход сверх предела просто не считается
    assert.equal((await beacon(s, { id: `hh-${i}`, kind: "hh", via: "google" }, visitor)).status, 204);
  }
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM vacancy_clicks"), HIT_VACANCIES);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM vacancy_clicks WHERE n != 1"), 0);
  // Дальше не считаются и уже знакомые вакансии: это обход ссылок, а не человек
  await beacon(s, { id: "hh-1", kind: "hh", via: "google" }, visitor);
  assert.equal(count(s, "SELECT n FROM vacancy_clicks WHERE vacancy_id = 'hh-1'"), 1);
  // Человек с другого адреса в тот же день считается как обычно, сколько бы раз он ни открыл одну вакансию
  for (let i = 0; i < 3; i++) await beacon(s, { id: "hh-1", kind: "hh", via: "google" }, { "x-forwarded-for": "198.51.100.2" });
  assert.equal(count(s, "SELECT n FROM vacancy_clicks WHERE vacancy_id = 'hh-1'"), 4);
  // Порог кнопок связи маячок не трогает: тот же посетитель получает номер работодателя
  const go = await s.call("GET", "/go/almatyrabota1-21258/wa?s=web", { headers: visitor });
  assert.match(String(go.headers.location), /^https:\/\/wa\.me\//);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM contact_clicks WHERE kind = 'robot'"), 0);
  // На следующий день счёт посетителя начинается заново
  tick(DAY);
  await beacon(s, { id: "hh-1", kind: "hh", via: "google" }, visitor);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM vacancy_clicks WHERE day = '2026-11-05'"), 1);
});

test("счёт обхода помнит ограниченное число посетителей: от потока разных адресов память не растёт", () => {
  const guard = new RobotGuard(1, 3);
  const now = Date.parse("2026-11-04T06:00:00Z");
  // Порог — одна вакансия: на второй посетитель уже робот
  assert.equal(guard.check("a", "hh-1", now), false);
  assert.equal(guard.check("a", "hh-2", now), true);
  // Посетителей стало больше, чем помним: счёт у всех начинается заново
  for (const visitor of ["b", "c", "d", "e"]) guard.check(visitor, "hh-1", now);
  assert.equal(guard.check("a", "hh-3", now), false);
});

test("разных источников визита и мест кнопки за день пишется не больше 40: новые сверх этого идут в other", async () => {
  const { s, tick } = await server();
  const distinct = (column: string) => count(s, `SELECT COUNT(DISTINCT ${column}) AS n FROM vacancy_clicks WHERE ${column} != ''`);
  // Поток выдуманных меток: как есть пишутся первые, остальные — в other
  for (let i = 0; i < 2 * LABELS_PER_DAY; i++) await beacon(s, { id: "hh-1", kind: "hh", via: `v${i}`, s: `s${i}` });
  assert.ok(distinct("via") <= LABELS_PER_DAY);
  assert.equal(count(s, "SELECT n FROM vacancy_clicks WHERE via = 'v0' AND source = 's0'"), 1);
  assert.ok(count(s, "SELECT SUM(n) AS n FROM vacancy_clicks WHERE via = 'other' AND source = 'other'") >= LABELS_PER_DAY);
  await beacon(s, { id: "hh-1", kind: "hh", via: "v0", s: "s0" }); // знакомая метка и дальше пишется как есть
  assert.equal(count(s, "SELECT n FROM vacancy_clicks WHERE via = 'v0' AND source = 's0'"), 2);

  // Свои метки поток не вытесняет: источники визита, которые определяет сайт, и места кнопок пишутся как есть
  const SITE_VIAS = ["direct", "other", "google", "yandex", "bing", "ddg", "chatgpt", "perplex", "gemini", "copilot", "claude", "tg", "ig", "2gis"];
  for (const via of SITE_VIAS) await beacon(s, { id: "hh-2", kind: "hh", via, s: "web" });
  assert.deepEqual(clicks(s, "vacancy_id = 'hh-2'").map((r) => [r.via, r.source, r.n]), [...SITE_VIAS].sort().map((via) => [via, "web", 1]));
  for (const place of ["web", "tg", "bot", "app"]) await beacon(s, { id: "hh-3", kind: "hh", s: place });
  assert.deepEqual(clicks(s, "vacancy_id = 'hh-3'").map((r) => r.source), ["app", "bot", "tg", "web"]);
  // Всего за день: 40 источников визита (other среди них) и 40 мест кнопки, не считая other
  assert.equal(distinct("via"), LABELS_PER_DAY);
  assert.equal(distinct("source"), LABELS_PER_DAY + 1);

  // Предел общий для маячка и кнопок связи, общий счётчик кнопок (contact_clicks) тоже пишет новую метку как other
  await s.call("GET", "/go/almatyrabota1-21258/wa?s=more&via=more");
  assert.deepEqual(clicks(s, "vacancy_id = 'almatyrabota1-21258'"), [
    { day: "2026-11-04", vacancy_id: "almatyrabota1-21258", kind: "wa", via: "other", source: "other", n: 1 },
  ]);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM contact_clicks WHERE source = 'more'"), 0);
  assert.equal(count(s, "SELECT n FROM contact_clicks WHERE source = 'other' AND kind = 'wa'"), 1);

  // На следующий день новые метки снова пишутся как есть
  tick(DAY);
  await beacon(s, { id: "hh-1", kind: "hh", via: "extra", s: "extra" });
  assert.deepEqual(clicks(s, "day = '2026-11-05'"), [{ day: "2026-11-05", vacancy_id: "hh-1", kind: "hh", via: "extra", source: "extra", n: 1 }]);
});

test("разных вакансий за день пишется не больше 5000: выдуманные id базу не раздувают", async () => {
  const { s, tick } = await server();
  // Каждая вакансия с нового адреса, чтобы предел на одного посетителя был ни при чём
  const from = (i: number) => ({ "x-forwarded-for": `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}` });
  const each = async (send: (i: number) => Promise<unknown>) => {
    for (let start = 0; start < VACANCIES_PER_DAY; start += 250) await Promise.all(Array.from({ length: 250 }, (_, k) => send(start + k)));
  };
  await each((i) => beacon(s, { id: `hh-${i}`, kind: "hh" }, from(i)));
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM vacancy_clicks"), VACANCIES_PER_DAY);
  assert.equal((await beacon(s, { id: "hh-new", kind: "hh" }, from(VACANCIES_PER_DAY))).status, 204);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM vacancy_clicks WHERE vacancy_id = 'hh-new'"), 0);
  // Знакомая вакансия считается дальше
  await beacon(s, { id: "hh-42", kind: "hh" }, from(VACANCIES_PER_DAY + 1));
  assert.equal(count(s, "SELECT n FROM vacancy_clicks WHERE vacancy_id = 'hh-42'"), 2);

  // У кнопок связи свой такой же предел: маячок его не расходует, а сверх него переход и общий счётчик работают как раньше
  await each((i) => s.call("GET", `/go/channel-${i}/wa?s=web`, { headers: from(i) }));
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM vacancy_clicks WHERE kind = 'miss'"), VACANCIES_PER_DAY);
  tick(61_000); // новая минута: сервер снова читает посты с t.me
  const r = await s.call("GET", "/go/almatyrabota1-21258/wa?s=web&via=google", { headers: from(VACANCIES_PER_DAY) });
  assert.match(String(r.headers.location), /^https:\/\/wa\.me\//);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM vacancy_clicks WHERE vacancy_id = 'almatyrabota1-21258'"), 0);
  assert.equal(count(s, "SELECT n FROM contact_clicks WHERE kind = 'wa'"), 1);

  // На следующий день счёт начинается заново
  tick(DAY);
  await beacon(s, { id: "hh-new", kind: "hh" }, from(1));
  await s.call("GET", "/go/almatyrabota1-21258/wa?s=web&via=google", { headers: from(1) });
  assert.deepEqual(clicks(s, "day = '2026-11-05'"), [
    { day: "2026-11-05", vacancy_id: "almatyrabota1-21258", kind: "wa", via: "google", source: "web", n: 1 },
    { day: "2026-11-05", vacancy_id: "hh-new", kind: "hh", via: "", source: "web", n: 1 },
  ]);
});

test("поток выдуманных меток в /go не раздувает общий счётчик кнопок: разных мест кнопки за день не больше предела", async () => {
  const { s } = await server();
  // С разных адресов, чтобы предел минуты на адрес был ни при чём
  for (let i = 0; i < 3 * LABELS_PER_DAY; i++) {
    await s.call("GET", `/go/somechannel-${i}/wa?s=x${i}`, { headers: { "x-forwarded-for": `192.0.2.${i}` } });
  }
  assert.ok(count(s, "SELECT COUNT(DISTINCT source) AS n FROM contact_clicks") <= LABELS_PER_DAY + 1);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM contact_clicks WHERE source IN ('web', 'tg', 'bot', 'app')"), 0);
  await s.call("GET", "/go/somechannel-1/wa?s=web", { headers: { "x-forwarded-for": "192.0.2.250" } });
  assert.equal(count(s, "SELECT n FROM contact_clicks WHERE source = 'web'"), 1); // свои места всегда пишутся как есть
});

test("с одного адреса в минуту записывается не больше 120 нажатий; что видит человек, не меняется", async () => {
  const { s, tick } = await server();
  const ip = { "x-forwarded-for": "203.0.113.9" };
  // Робот-фильтр (15 вакансий) не должен сработать раньше: жмём одну и ту же вакансию
  for (let i = 0; i < COUNTS_PER_MINUTE + 30; i++) {
    const r = await s.call("GET", "/go/almatyrabota1-21300/wa?s=web", { headers: ip });
    assert.equal(r.status, 302);
  }
  assert.equal(count(s, "SELECT SUM(n) AS n FROM contact_clicks"), COUNTS_PER_MINUTE);
  // Маячок с того же адреса в ту же минуту тоже не пишется, с другого адреса пишется
  await beacon(s, { id: "hh-5", kind: "hh" }, ip);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM vacancy_clicks WHERE vacancy_id = 'hh-5'"), 0);
  await beacon(s, { id: "hh-5", kind: "hh" }, { "x-forwarded-for": "198.51.100.9" });
  assert.equal(count(s, "SELECT n FROM vacancy_clicks WHERE vacancy_id = 'hh-5'"), 1);
  // Новая минута: снова пишется
  tick(61_000);
  await s.call("GET", "/go/almatyrabota1-21300/wa?s=web", { headers: ip });
  assert.equal(count(s, "SELECT SUM(n) AS n FROM contact_clicks"), COUNTS_PER_MINUTE + 1);
});

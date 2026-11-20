import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { moderationKey } from "../src/employer.js";
import worker, { nudgeDrafts } from "../src/index.js";
import { webhookSecret } from "../src/logic.js";

// D1 поверх встроенного в Node SQLite со всеми миграциями: проверяем настоящие запросы бота
function testDB() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  const plain = (row) => (row ? { ...row } : null);
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    first: async (column) => {
      const row = plain(db.prepare(sql).get(...args));
      return column ? (row ? row[column] : null) : row;
    },
    all: async () => ({ results: db.prepare(sql).all(...args).map(plain) }),
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return { prepare: (sql) => statement(sql), get: (sql, ...args) => plain(db.prepare(sql).get(...args)) };
}

function fakeEnv() {
  return {
    DB: testDB(),
    TELEGRAM_BOT_TOKEN: "1:test",
    SITE_URL: "https://vacante.kz",
    SERVER_URL: "https://api.vacante.kz",
    CHANNELS: "@vacanteastana,@vacantealmaty",
  };
}

// Поддельный Telegram: запоминает вызовы, админом канала считается только пользователь 900
function fakeFetch(calls) {
  let messageId = 1000;
  return async (url, init) => {
    if (String(url).endsWith("/feed.json")) {
      return Response.json({ vacancies: [{ id: "a", city: "almaty", category: "horeca", perks: [], pay: 0, html: "<b>Бариста</b>" }] });
    }
    // Сервер в Казахстане: номер в профиль он берёт, только если приложение его попросило
    if (String(url).startsWith("https://api.vacante.kz/")) {
      calls.push({ method: "server", url: String(url), auth: init.headers.authorization, body: JSON.parse(init.body) });
      return Response.json({ ok: true, handled: false });
    }
    if (String(url).startsWith("https://api.github.com/")) {
      calls.push({ method: "github", url: String(url) });
      return new Response(null, { status: 204 });
    }
    const method = String(url).split("/").pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    if (method === "getChatMember") {
      return Response.json({ ok: true, result: { status: body.user_id === 900 ? "creator" : "left" } });
    }
    return Response.json({ ok: true, result: method === "sendMessage" ? { message_id: ++messageId } : {} });
  };
}

// ctx как у Cloudflare: фоновые задачи (запуск обновления сайта) собираем, чтобы дождаться их в тесте
const ctx = { tasks: [], waitUntil(promise) { this.tasks.push(promise); } };

async function post(env, update, secret) {
  const headers = { "X-Telegram-Bot-Api-Secret-Token": secret ?? (await webhookSecret(env.TELEGRAM_BOT_TOKEN)) };
  return worker.fetch(new Request("https://bot.example/telegram", { method: "POST", headers, body: JSON.stringify(update) }), env, ctx);
}

async function moderateApi(env, decisions, key) {
  const headers = { Authorization: `Bearer ${key ?? (await moderationKey(env.TELEGRAM_BOT_TOKEN))}` };
  const res = await worker.fetch(
    new Request("https://bot.example/api/moderate", { method: "POST", headers, body: JSON.stringify({ decisions }) }), env, ctx);
  await Promise.all(ctx.tasks.splice(0));
  return res;
}

const user = (id, first_name, username) => ({ id, first_name, ...(username ? { username } : {}) });
const say = (env, from, text) => post(env, { message: { chat: { id: from.id, type: "private" }, from, text } });
const press = (env, from, data, message_id = 1) =>
  post(env, { callback_query: { id: "q", from, data, message: { chat: { id: from.id }, message_id } } });
const sentTo = (calls, chatId) => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chatId);

test("от /start до «Готово» и первых примеров", async () => {
  const env = fakeEnv();
  const calls = [];
  globalThis.fetch = fakeFetch(calls);
  const me = user(7, "Аян");
  await say(env, me, "/start");
  assert.equal(calls[0].method, "sendMessage");
  assert.match(calls[0].body.text, /листать свайпами/);
  assert.deepEqual(calls[0].body.reply_markup.inline_keyboard[0][0].web_app, { url: "https://vacante.kz/app/" });
  assert.match(calls[1].body.text, /^Где ищете работу/);
  for (const data of ["city:almaty", "go:perks", "done"]) await press(env, me, data);
  const done = calls.findLast((c) => c.method === "editMessageText");
  assert.match(done.body.text, /^Готово!/);
  assert.deepEqual(done.body.reply_markup.inline_keyboard[0][0].web_app, { url: "https://vacante.kz/app/?city=almaty" });
  assert.deepEqual(env.DB.get("SELECT city, categories, perks, min_pay, active FROM subscribers WHERE chat_id = 7"),
    { city: "almaty", categories: "", perks: "", min_pay: 0, active: 1 });
  const last = calls.at(-1);
  assert.equal(last.method, "sendMessage");
  assert.equal(last.body.text, "Вот последние подходящие:\n\n<b>Бариста</b>");
  await say(env, me, "/stop");
  assert.equal(env.DB.get("SELECT active FROM subscribers WHERE chat_id = 7").active, 0);
});

test("работодатель с /start: кнопка «Ищу сотрудников», меню и анкета из меню", async () => {
  const env = fakeEnv();
  const calls = [];
  globalThis.fetch = fakeFetch(calls);
  const boss = user(110, "Айжан");
  await say(env, boss, "/start");
  assert.deepEqual(calls[0].body.reply_markup.inline_keyboard[1][0], { text: "🏢 Ищу сотрудников", callback_data: "emp" });
  await press(env, boss, "emp");
  assert.match(sentTo(calls, 110).at(-1).body.text, /Найдём сотрудников/);
  await say(env, boss, "/employer");
  const menu = sentTo(calls, 110).at(-1).body;
  assert.match(menu.text, /Размещение бесплатное/);
  await press(env, boss, "emp:vacancy");
  assert.match(sentTo(calls, 110).at(-1).body.text, /Вопрос 1 из 7<\/i>\nВ каком городе работа/);
  await press(env, boss, "emp:jobs");
  assert.match(sentTo(calls, 110).at(-1).body.text, /пока нет вакансий/);
  await press(env, boss, "emp:company");
  const relayed = calls.findLast((c) => c.method === "server");
  assert.equal(relayed.body.message.text, "/company");
  assert.match(sentTo(calls, 110).at(-1).body.text, /Профиль компании сейчас недоступен/);
});

test("чужие запросы без секрета отклоняются", async () => {
  const res = await post(fakeEnv(), { message: { chat: { id: 1, type: "private" }, text: "/start" } }, "wrong");
  assert.equal(res.status, 403);
});

test("работодатель размещает вакансию, модератор одобряет, кандидат откликается", async () => {
  const env = fakeEnv();
  const calls = [];
  globalThis.fetch = fakeFetch(calls);
  const boss = user(100, "Дана", "dana_cafe");
  const admin = user(900, "Мирас");
  const stranger = user(555, "Хитрец");
  const candidate = user(300, "Ерлан");

  // Модератор подтверждает, что он админ канала; посторонний модератором не становится
  await say(env, admin, "/admin");
  assert.match(sentTo(calls, 900).at(-1).body.text, /вы модератор/);
  await say(env, stranger, "/admin");
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM admins").n, 1);

  // Анкета: город кнопкой, остальное текстом, необязательное можно пропустить
  await say(env, boss, "/start post");
  assert.match(sentTo(calls, 100).at(-1).body.text, /В каком городе работа/);
  await press(env, boss, "jobcity:almaty", 11);
  assert.equal(calls.at(-1).method, "editMessageText");
  assert.match(calls.at(-1).body.text, /Кого ищете/);
  await say(env, boss, "Официант");
  await say(env, boss, "Кафе «Зерно»");
  await say(env, boss, "x".repeat(81));
  assert.match(sentTo(calls, 100).at(-1).body.text, /Слишком длинно/);
  await say(env, boss, "12 000 ₸ за смену");
  await say(env, boss, "2/2");
  await press(env, boss, "skip:schedule", 12); // устаревшая кнопка: график уже ответили, ничего не меняет
  await press(env, boss, "skip:address", 13);
  await say(env, boss, "Питание и развозка");
  const preview = sentTo(calls, 100).at(-1).body;
  assert.match(preview.text, /Проверьте вакансию/);
  assert.match(preview.text, /<b>Официант<\/b>\n🏢 Кафе «Зерно»\n📍 Алматы\n💰 <b>12 000 ₸ за смену<\/b>\n🕒 2\/2/);
  assert.deepEqual(env.DB.get("SELECT status, step, address FROM jobs"), { status: "draft", step: null, address: "" });

  // На проверку: модератор получает карточку с кнопками
  await press(env, boss, "jobsend", 14);
  const job = env.DB.get("SELECT * FROM jobs");
  assert.equal(job.status, "pending");
  const moderation = sentTo(calls, 900).at(-1).body;
  assert.match(moderation.text, /Дана \(@dana_cafe\)/);
  assert.deepEqual(moderation.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [`mod:ok:${job.id}`, `mod:no:${job.id}`]);

  // Чужие нажатия ничего не меняют
  await press(env, stranger, `mod:ok:${job.id}`);
  await press(env, stranger, `close:${job.id}`);
  assert.equal(env.DB.get("SELECT status FROM jobs").status, "pending");

  await press(env, admin, `mod:ok:${job.id}`, 21);
  const approved = env.DB.get("SELECT status, approved_at FROM jobs");
  assert.equal(approved.status, "approved");
  assert.ok(approved.approved_at);
  assert.match(sentTo(calls, 100).at(-1).body.text, /прошла проверку/);
  await press(env, admin, `mod:no:${job.id}`, 21); // повторное нажатие: решение уже принято
  assert.equal(env.DB.get("SELECT status FROM jobs").status, "approved");
  assert.match(calls.filter((c) => c.method === "editMessageText").at(-1).body.text, /✅ Опубликована: Мирас/);

  // Отклик: ссылка из карточки на сайте, номер кнопкой «Отправить мой номер»
  await say(env, candidate, `/start apply_${job.id}`);
  const intro = sentTo(calls, 300).at(-1).body;
  assert.match(intro.text, /Отклик на вакансию/);
  assert.equal(intro.reply_markup.keyboard[0][0].request_contact, true);
  await post(env, { message: { chat: { id: 300, type: "private" }, from: candidate, contact: { phone_number: "+77010000000" } } });
  assert.equal(calls.filter((c) => c.method === "server").length, 1); // сервер номер не ждал: он для отклика
  const application = sentTo(calls, 100).at(-1).body.text;
  assert.match(application, /Отклик на «Официант»/);
  assert.match(application, /Ерлан, 📱 \+77010000000/);
  assert.match(application, /tg:\/\/user\?id=300/);
  assert.match(sentTo(calls, 300).at(-1).body.text, /Отклик отправлен/);
  await say(env, candidate, `/start apply_${job.id}`);
  assert.match(sentTo(calls, 300).at(-1).body.text, /уже откликнулись/);

  // Работодатель видит отклики и закрывает вакансию; после этого откликнуться нельзя
  await say(env, boss, "/myjobs");
  const jobs = sentTo(calls, 100).at(-1).body;
  assert.match(jobs.text, /опубликована, откликов: 1/);
  assert.equal(jobs.reply_markup.inline_keyboard[0][0].callback_data, `apps:${job.id}`);
  // «📩 Отклики»: бот присылает то же сообщение с откликом ещё раз, сам текст отклика не хранит
  const noticeId = env.DB.get("SELECT notice_id FROM applications").notice_id;
  assert.ok(noticeId);
  await press(env, stranger, `apps:${job.id}`);
  assert.equal(calls.filter((c) => c.method === "copyMessage").length, 0);
  await press(env, boss, `apps:${job.id}`);
  assert.match(sentTo(calls, 100).at(-1).body.text, /Отклики на «Официант»: 1\. Ниже они ещё раз/);
  assert.deepEqual(calls.at(-1), { method: "copyMessage", body: { chat_id: 100, from_chat_id: 100, message_id: noticeId } });
  await press(env, boss, `close:${job.id}`, 31);
  assert.equal(env.DB.get("SELECT status FROM jobs").status, "closed");
  await say(env, user(301, "Асель"), `/start apply_${job.id}`);
  assert.match(sentTo(calls, 301).at(-1).body.text, /уже закрыта/);
});

test("работодатель со страницы профиля кандидата: та же анкета, в вакансии отметка, откуда пришёл", async () => {
  const env = fakeEnv();
  const calls = [];
  globalThis.fetch = fakeFetch(calls);
  await say(env, user(100, "Дана", "dana_cafe"), "/start post_pf");
  assert.match(sentTo(calls, 100).at(-1).body.text, /В каком городе работа/);
  assert.equal(env.DB.get("SELECT came_from FROM jobs WHERE employer_chat = 100").came_from, "profile");
  await say(env, user(101, "Ерлан"), "/start post");
  assert.equal(env.DB.get("SELECT came_from FROM jobs WHERE employer_chat = 101").came_from, null);
});

test("вакансии до /admin ждут модератора, лимит на проверке, отмена анкеты", async () => {
  const env = fakeEnv();
  const calls = [];
  globalThis.fetch = fakeFetch(calls);
  const boss = user(100, "Дана");
  const fill = async () => {
    await say(env, boss, "/vacancy");
    await press(env, boss, "jobcity:astana");
    for (const answer of ["Повар", "Кафе", "300 000 ₸"]) await say(env, boss, answer);
    for (const field of ["schedule", "address", "details"]) await press(env, boss, `skip:${field}`);
    await press(env, boss, "jobsend");
  };
  for (let i = 0; i < 3; i++) await fill();
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'").n, 3);
  await say(env, boss, "/vacancy");
  assert.match(sentTo(calls, 100).at(-1).body.text, /уже 3 вакансии ждут оплаты или проверки/);

  // Модератор появился позже: получает всё, что ждёт проверки
  await say(env, user(900, "Мирас"), "/admin");
  const toAdmin = sentTo(calls, 900);
  assert.match(toAdmin[0].body.text, /Сейчас ждут: 3/);
  assert.equal(toAdmin.length, 4);

  // Отмена анкеты: черновик удаляется, текст больше не считается ответом
  await press(env, user(900, "Мирас"), "mod:no:1");
  await say(env, boss, "/vacancy");
  await press(env, boss, "jobcancel");
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM jobs WHERE status = 'draft'").n, 0);
  await say(env, boss, "Повар");
  assert.match(sentTo(calls, 100).at(-1).body.text, /Работодателям: \/employer/);
  assert.ok(sentTo(calls, 100).some((c) => /не опубликовали/.test(c.body.text)));
});

test("агент оформляет и публикует вакансию, отклоняет с причиной, правит опубликованную", async () => {
  const env = { ...fakeEnv(), GH_DISPATCH_TOKEN: "gh", GITHUB_REPO: "mirasito/vacante" };
  const calls = [];
  globalThis.fetch = fakeFetch(calls);
  const boss = user(100, "Дана");
  const admin = user(900, "Мирас", "mirasimus");
  await say(env, admin, "/admin");
  const fill = async (title, salary) => {
    await say(env, boss, "/vacancy");
    await press(env, boss, "jobcity:almaty");
    for (const answer of [title, "Алматысу", salary]) await say(env, boss, answer);
    await say(env, boss, "Обычный с девяти до шести");
    for (const field of ["address", "details"]) await press(env, boss, `skip:${field}`);
    await press(env, boss, "jobsend");
    await Promise.all(ctx.tasks.splice(0));
  };
  await fill("Электрик первого разряда", "2500 00 + бонусы");
  assert.equal(calls.filter((c) => c.method === "github").length, 1); // заявка сразу обновляет очередь на сайте
  await fill("Работа в интернете", "100 000");
  await fill("Сварщик", "400 000");

  // Без ключа нельзя
  assert.equal((await moderateApi(env, [], "wrong")).status, 403);
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'").n, 3);

  // Мирас успел сам опубликовать №3 как есть
  const notice3 = env.DB.get("SELECT message_id FROM notices WHERE job_id = 3");
  await press(env, admin, "mod:ok:3", notice3.message_id);

  calls.length = 0;
  const res = await moderateApi(env, [
    { id: 1, verdict: "approve", fields: { title: "Электрик 1-го разряда", company: "Алматы Су", salary: "250 000 ₸ в месяц + бонусы",
      schedule: "09:00–18:00", salary_min: 250000, salary_period: "month" } },
    { id: 2, verdict: "reject", reason: "похоже на «работу в интернете», а не на настоящую вакансию" },
    { id: 3, verdict: "approve", fields: { salary: "400 000 ₸ в месяц", salary_min: 400000, salary_period: "month" } },
    { id: 4, verdict: "approve" },
    { id: 1, verdict: "edit", fields: { salary_min: 250, salary_period: "month" } },
  ]);
  assert.deepEqual((await res.json()).results, [
    { id: 1, result: "approved" },
    { id: 2, result: "rejected" },
    { id: 3, result: "edited" },
    { id: 4, result: "error: нет такой вакансии" },
    { id: 1, result: "error: salary: сумма за month вне 40000–5000000" },
  ]);

  const first = env.DB.get("SELECT * FROM jobs WHERE id = 1");
  assert.equal(first.status, "approved");
  assert.equal(first.decided_by, "агент");
  assert.ok(first.reviewed_at && first.approved_at);
  assert.deepEqual([first.salary, first.salary_min, first.salary_max, first.salary_period, first.schedule],
    ["250 000 ₸ в месяц + бонусы", 250000, null, "month", "09:00–18:00"]);
  const toBoss = calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === 100).map((c) => c.body.text);
  assert.match(toBoss[0], /прошла проверку[\s\S]*Электрик 1-го разряда[\s\S]*💰 <b>250 000 ₸ в месяц \+ бонусы<\/b>/);
  assert.match(toBoss[1], /не опубликовали\. Причина: похоже на «работу в интернете»/);
  assert.equal(toBoss.length, 2); // правка уже опубликованной №3 работодателю не пишется

  // Карточки у модератора обновились: кто решил, без кнопок
  const edits = calls.filter((c) => c.method === "editMessageText" && c.body.chat_id === 900);
  assert.match(edits[0].body.text, /✅ Опубликована: агент$/);
  assert.equal(edits[0].body.reply_markup, undefined);
  assert.match(edits[1].body.text, /❌ Отклонена: агент$/);
  assert.match(edits[2].body.text, /💰 <b>400 000 ₸ в месяц<\/b>[\s\S]*✅ Опубликована: Мирас \(@mirasimus\)$/);
  const third = env.DB.get("SELECT decided_by, reviewed_at FROM jobs WHERE id = 3");
  assert.equal(third.decided_by, "Мирас (@mirasimus)");
  assert.ok(third.reviewed_at);
  assert.equal(calls.filter((c) => c.method === "github").length, 1); // одно обновление сайта на всю пачку
});

test("«Срочно»: работодатель платит на Kaspi, модератор подтверждает, вакансия поднимается", async () => {
  const env = { ...fakeEnv(), KASPI_DETAILS: "+7 700 000 00 00, Мирас Б.", BOOST_PRICE: "3000", BOOST_DAYS: "7" };
  const calls = [];
  globalThis.fetch = fakeFetch(calls);
  const boss = user(100, "Дана", "dana_cafe");
  const admin = user(900, "Мирас");
  const stranger = user(555, "Хитрец");
  await say(env, admin, "/admin");
  env.DB.prepare(
    `INSERT INTO jobs (employer_chat, employer_name, status, city, title, company, salary, approved_at)
     VALUES (100, 'Дана', 'pending', 'astana', 'Повар', 'Кафе', '300 000 ₸', NULL)`,
  ).run();
  await press(env, admin, "mod:ok:1", 21);
  const approved = sentTo(calls, 100).at(-1).body;
  assert.match(approved.text, /Тариф Про за 3 000 ₸/);
  assert.equal(approved.reply_markup.inline_keyboard[0][0].callback_data, "boost:1");

  // Чужую вакансию поднять нельзя
  await press(env, stranger, "boost:1");
  await press(env, stranger, "paid:1");
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM payments").n, 0);

  await press(env, boss, "boost:1");
  const offer = sentTo(calls, 100).at(-1).body;
  assert.match(offer.text, /\+7 700 000 00 00, Мирас Б\./);
  assert.match(offer.text, /«№1»/);
  await press(env, boss, "paid:1", 31);
  await press(env, boss, "paid:1", 31); // второй раз: уже сверяем
  assert.deepEqual(env.DB.get("SELECT job_id, amount, days, status FROM payments"), { job_id: 1, amount: 3000, days: 7, status: "pending" });
  const card = sentTo(calls, 900).at(-1).body;
  assert.match(card.text, /Оплата Про №1: <b>3 000 ₸<\/b>/);
  assert.deepEqual(card.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["pay:ok:1", "pay:no:1"]);

  await press(env, stranger, "pay:ok:1");
  assert.equal(env.DB.get("SELECT boost_until FROM jobs").boost_until, null);
  await press(env, admin, "pay:ok:1", 41);
  const boosted = env.DB.get("SELECT boost_until, julianday(boost_until) - julianday('now') AS left FROM jobs");
  assert.ok(boosted.left > 6.99 && boosted.left < 7.01);
  assert.match(sentTo(calls, 100).at(-1).body.text, /Тариф Про включён/);
  assert.equal(env.DB.get("SELECT status, decided_by FROM payments").decided_by, "Мирас");
  assert.match(calls.filter((c) => c.method === "editMessageText").at(-1).body.text, /✅ Деньги пришли: Мирас/);

  // Продление считается от конца текущего «Срочно»; неподтверждённый перевод ничего не меняет
  await press(env, boss, "paid:1", 32);
  await press(env, admin, "pay:no:2", 42);
  assert.match(sentTo(calls, 100).at(-1).body.text, /не нашли перевод/);
  await press(env, boss, "paid:1", 33);
  await press(env, admin, "pay:ok:3", 43);
  await press(env, admin, "pay:ok:3", 43); // повторное нажатие не продлевает ещё раз
  const left = env.DB.get("SELECT julianday(boost_until) - julianday('now') AS left FROM jobs").left;
  assert.ok(left > 13.99 && left < 14.01);

  await say(env, boss, "/myjobs");
  const mine = sentTo(calls, 100).at(-1).body;
  assert.match(mine.text, /🔥 срочно до \d\d\.\d\d/);
  assert.match(mine.reply_markup.inline_keyboard[0][0].text, /Продлить Про №1: 3 000 ₸/);
});

test("платное размещение: оплата на Kaspi, потом проверка; модератор размещает бесплатно; при отказе вернуть деньги", async () => {
  const env = { ...fakeEnv(), KASPI_DETAILS: "+7 700 000 00 00, Мирас Б.", POST_PRICE: "900" };
  const calls = [];
  globalThis.fetch = fakeFetch(calls);
  const boss = user(100, "Дана", "dana_cafe");
  const admin = user(900, "Мирас");
  await say(env, admin, "/admin");

  await say(env, boss, "/vacancy");
  assert.match(sentTo(calls, 100).at(-1).body.text, /Разместим вакансию за 900 ₸/);
  await press(env, boss, "jobcity:astana", 11);
  await say(env, boss, "Повар");
  await say(env, boss, "Кафе");
  await say(env, boss, "300 000 ₸");
  await press(env, boss, "skip:schedule", 12);
  await press(env, boss, "skip:address", 12);
  await press(env, boss, "skip:details", 12);
  const preview = calls.at(-1).body;
  assert.match(preview.text, /Выберите тариф[\s\S]*Базовый, 900 ₸[\s\S]*Про, 3 990 ₸/);
  assert.deepEqual(preview.reply_markup.inline_keyboard.slice(0, 2).map((r) => r[0].text), ["✅ Базовый: 900 ₸", "🔥 Про: 3 990 ₸"]);

  // «К оплате»: вакансия ждёт оплаты, модераторам пока ничего
  const before = sentTo(calls, 900).length;
  await press(env, boss, "jobsend", 12);
  assert.equal(env.DB.get("SELECT status FROM jobs").status, "payment");
  assert.match(calls.at(-1).body.text, /переведите <b>900 ₸<\/b> на Kaspi\n\+7 700 000 00 00, Мирас Б\.[\s\S]*«№1»/);
  assert.equal(sentTo(calls, 900).length, before);
  await press(env, boss, "postlater:1", 12);
  await say(env, boss, "/myjobs");
  const mine = sentTo(calls, 100).at(-1).body;
  assert.match(mine.text, /ждёт оплаты/);
  assert.equal(mine.reply_markup.inline_keyboard[0][0].callback_data, "postpay:1");

  await press(env, user(555, "Хитрец"), "postpaid:1");
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM payments").n, 0);
  await press(env, boss, "postpaid:1", 13);
  await press(env, boss, "postpaid:1", 13); // второй раз: уже сверяем
  assert.deepEqual(env.DB.get("SELECT kind, amount, status FROM payments"), { kind: "post", amount: 900, status: "pending" });
  assert.match(sentTo(calls, 900).at(-1).body.text, /Оплата размещения №1: <b>900 ₸<\/b>\n/);

  // Перевод не нашли: вакансия так и ждёт оплаты
  await press(env, admin, "pay:no:1", 41);
  assert.match(sentTo(calls, 100).at(-1).body.text, /не нашли перевод за размещение/);
  assert.equal(env.DB.get("SELECT status FROM jobs").status, "payment");

  // Деньги пришли: вакансия на проверке, модераторы получают карточку
  await press(env, boss, "postpaid:1", 14);
  await press(env, admin, "pay:ok:2", 42);
  assert.deepEqual(env.DB.get("SELECT status, post_paid FROM jobs"), { status: "pending", post_paid: 900 });
  assert.match(sentTo(calls, 100).at(-1).body.text, /Оплата получена[\s\S]*на проверке/);
  assert.deepEqual(sentTo(calls, 900).at(-1).body.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["mod:ok:1", "mod:no:1"]);

  // Отказ после оплаты: работодателю обещаем вернуть деньги, модераторам напоминаем
  await press(env, admin, "mod:no:1", 51);
  assert.match(sentTo(calls, 100).at(-1).body.text, /вернём на ваш Kaspi/);
  assert.match(calls.filter((c) => c.method === "editMessageText").at(-1).body.text, /заплатил 900 ₸ за размещение: верните перевод/);

  // Модератор размещает сам без оплаты
  await say(env, admin, "/vacancy");
  assert.doesNotMatch(sentTo(calls, 900).at(-1).body.text, /900 ₸/);
});

test("тарифы: Про сразу при размещении, пакет Про, Про из пакета и итог по откликам", async () => {
  const env = { ...fakeEnv(), KASPI_DETAILS: "+7 700 000 00 00, Мирас Б.", POST_PRICE: "990", BOOST_PRICE: "3990", BOOST_DAYS: "14",
    PACKS: "3:9990:60,10:29990:90" };
  const calls = [];
  globalThis.fetch = fakeFetch(calls);
  const boss = user(100, "Дана", "dana_cafe");
  const admin = user(900, "Мирас");
  await say(env, admin, "/admin");
  const fill = async () => {
    await say(env, boss, "/vacancy");
    await press(env, boss, "jobcity:astana", 11);
    for (const text of ["Повар", "Кафе", "300 000 ₸"]) await say(env, boss, text);
    for (const f of ["schedule", "address", "details"]) await press(env, boss, `skip:${f}`, 12);
    return calls.at(-1).body;
  };

  // Про сразу: одна оплата 3 990 ₸, после подтверждения на проверке уже со сроком Про
  const preview = await fill();
  assert.deepEqual(preview.reply_markup.inline_keyboard.slice(0, 3).map((r) => r[0].callback_data), ["jobsend", "jobpro", "packs"]);
  await press(env, boss, "jobpro", 12);
  assert.deepEqual(env.DB.get("SELECT status, pro FROM jobs WHERE id = 1"), { status: "payment", pro: 1 });
  assert.match(calls.at(-1).body.text, /тарифу Про за 3 990 ₸[\s\S]*переведите <b>3 990 ₸<\/b>/);
  await press(env, boss, "postpaid:1", 13);
  assert.deepEqual(env.DB.get("SELECT kind, amount, days FROM payments"), { kind: "post", amount: 3990, days: 14 });
  assert.match(sentTo(calls, 900).at(-1).body.text, /Оплата размещения Про №1: <b>3 990 ₸<\/b> на 14 дней/);
  await press(env, admin, "pay:ok:1", 41);
  const pro = env.DB.get("SELECT status, post_paid, julianday(boost_until) - julianday('now') AS left FROM jobs WHERE id = 1");
  assert.equal(pro.status, "pending");
  assert.equal(pro.post_paid, 3990);
  assert.ok(pro.left > 13.99 && pro.left < 14.01);
  assert.match(sentTo(calls, 100).at(-1).body.text, /Тариф Про оплачен/);
  await press(env, admin, "mod:ok:1", 51);
  assert.match(sentTo(calls, 100).at(-1).body.text, /🔥 Тариф Про до \d\d\.\d\d\./);

  // Пакет: экран, оплата, модератор подтверждает, у работодателя 3 Про на 60 дней
  await press(env, boss, "packs");
  const packs = sentTo(calls, 100).at(-1).body;
  assert.match(packs.text, /3 вакансий Про за 9 990 ₸<\/b>: 3 330 ₸ за одну вместо 3 990 ₸/);
  assert.deepEqual(packs.reply_markup.inline_keyboard.map((r) => r[0].callback_data), ["pack:3", "pack:10"]);
  await press(env, boss, "pack:7", 61);  // такого пакета нет
  await press(env, boss, "pack:3", 61);
  assert.match(calls.at(-1).body.text, /«Пакет 3»/);
  await press(env, boss, "packpaid:3", 61);
  await press(env, boss, "packpaid:3", 61);  // второй раз: уже сверяем
  assert.deepEqual(env.DB.get("SELECT job_id, kind, amount, days, pack FROM payments WHERE id = 2"),
    { job_id: 0, kind: "pack", amount: 9990, days: 60, pack: 3 });
  assert.match(sentTo(calls, 900).at(-1).body.text, /Оплата пакета «3 Про» №2: <b>9 990 ₸<\/b> на 60 дней\nОт: Дана \(@dana_cafe\)[\s\S]*«Пакет 3»/);
  await press(env, admin, "pay:ok:2", 62);
  assert.equal(env.DB.get("SELECT left FROM credits").left, 3);
  assert.match(sentTo(calls, 100).at(-1).body.text, /Пакет включён: 3 вакансий Про/);
  assert.match(calls.filter((c) => c.method === "editMessageText").at(-1).body.text, /✅ Деньги пришли: Мирас/);

  // Новая вакансия: «Про из пакета» без оплаты, сразу на проверку со сроком Про
  const second = await fill();
  assert.equal(second.reply_markup.inline_keyboard[2][0].text, "🔥 Про из пакета, осталось 3");
  await press(env, boss, "jobcredit", 12);
  assert.deepEqual(env.DB.get("SELECT status, pro FROM jobs WHERE id = 2"), { status: "pending", pro: 1 });
  assert.ok(env.DB.get("SELECT boost_until FROM jobs WHERE id = 2").boost_until);
  assert.equal(env.DB.get("SELECT left FROM credits").left, 2);
  assert.match(sentTo(calls, 900).at(-1).body.reply_markup.inline_keyboard[0][0].callback_data, /^mod:ok:2$/);

  // Опубликованную поднять из пакета: кнопка в окне Про
  env.DB.prepare(`INSERT INTO jobs (employer_chat, employer_name, status, city, title, company, salary, approved_at)
     VALUES (100, 'Дана', 'approved', 'astana', 'Бариста', 'Кафе', '250 000 ₸', datetime('now'))`).run();
  await press(env, boss, "boost:3");
  assert.equal(sentTo(calls, 100).at(-1).body.reply_markup.inline_keyboard[1][0].callback_data, "usecredit:3");
  await press(env, user(555, "Хитрец"), "usecredit:3");
  assert.equal(env.DB.get("SELECT left FROM credits").left, 2);
  await press(env, boss, "usecredit:3", 71);
  assert.equal(env.DB.get("SELECT left FROM credits").left, 1);
  assert.match(calls.at(-1).body.text, /Тариф Про включён[\s\S]*Осталось Про в пакетах: 1/);

  // Срок кончился: итог по откликам один раз
  env.DB.prepare("UPDATE jobs SET boost_until = datetime('now', '-1 hour') WHERE id = 3").run();
  env.DB.prepare("INSERT INTO applications (job_id, chat_id) VALUES (3, 300), (3, 301)").run();
  const { proReports } = await import("../src/index.js");
  assert.equal(await proReports(env), 1);
  const report = sentTo(calls, 100).at(-1).body;
  assert.match(report.text, /Итог тарифа Про по «Бариста»: откликов 2/);
  assert.equal(report.reply_markup.inline_keyboard[0][0].callback_data, "boost:3");
  assert.equal(await proReports(env), 0);
});

test("без реквизитов Kaspi кнопок «Поднять» нет", async () => {
  const env = fakeEnv();
  const calls = [];
  globalThis.fetch = fakeFetch(calls);
  const boss = user(100, "Дана");
  env.DB.prepare(
    `INSERT INTO jobs (employer_chat, employer_name, status, city, title, company, salary, approved_at)
     VALUES (100, 'Дана', 'approved', 'astana', 'Повар', 'Кафе', '300 000 ₸', datetime('now'))`,
  ).run();
  await say(env, boss, "/myjobs");
  assert.deepEqual(sentTo(calls, 100).at(-1).body.reply_markup.inline_keyboard.map((r) => r[0].callback_data), ["close:1"]);
  await press(env, boss, "paid:1");
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM payments").n, 0);
});

test("номер из окна Telegram в приложении уходит серверу, остальное бот ведёт сам", async () => {
  const env = fakeEnv();
  const calls = [];
  const telegram = fakeFetch(calls);
  let server = "handled";
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.vacante.kz/") && server !== "mine") {
      calls.push({ method: "server", url: String(url), auth: init.headers.authorization, body: JSON.parse(init.body) });
      if (server === "down") throw new TypeError("fetch failed");
      return Response.json({ ok: true, handled: true });
    }
    return telegram(url, init);
  };
  const seeker = user(400, "Айгерим");
  const update = { message: { chat: { id: 400, type: "private" }, from: seeker, contact: { phone_number: "+77015556677", user_id: 400 } } };

  // Сервер положил номер в профиль и ответил сам: бот молчит
  await post(env, update);
  const relayed = calls.filter((c) => c.method === "server");
  assert.equal(relayed.length, 1);
  assert.equal(relayed[0].url, "https://api.vacante.kz/internal/telegram");
  // Ключ тот же, что считает сервер: HMAC-SHA256 от токена бота (server/src/telegram.ts)
  const key = createHmac("sha256", env.TELEGRAM_BOT_TOKEN).update("vacante-server-internal").digest("hex");
  assert.equal(relayed[0].auth, `Bearer ${key}`);
  assert.deepEqual(relayed[0].body, update);
  assert.equal(sentTo(calls, 400).length, 0);

  // Сервер недоступен или номер не ждал: бот отвечает, как раньше
  server = "down";
  await post(env, update);
  assert.match(sentTo(calls, 400).at(-1).body.text, /Я присылаю новые вакансии/);
  server = "mine";
  await post(env, update);
  assert.equal(sentTo(calls, 400).length, 2);

  // Без адреса сервера и для обычных сообщений бот к серверу не ходит
  const before = calls.filter((c) => c.method === "server").length;
  await post({ ...env, SERVER_URL: "" }, update);
  await say(env, seeker, "привет");
  assert.equal(calls.filter((c) => c.method === "server").length, before);
});

test("кружок, /start video и кнопки «v:» ведёт сервер, без него бот так и отвечает", async () => {
  const env = fakeEnv();
  const calls = [];
  const telegram = fakeFetch(calls);
  let up = true;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.vacante.kz/")) {
      calls.push({ method: "server", body: JSON.parse(init.body) });
      if (!up) throw new TypeError("fetch failed");
      return Response.json({ ok: true, handled: true });
    }
    return telegram(url, init);
  };
  const seeker = user(500, "Ерлан");
  const chat = { id: 500, type: "private" };
  const circle = { message: { chat, from: seeker, video_note: { file_id: "vn", file_unique_id: "AgAD", duration: 30 } } };
  const relayed = () => calls.filter((c) => c.method === "server");

  // Сервер принял: бот молчит, ответит сам сервер
  await post(env, circle);
  await say(env, seeker, "/start video");
  await press(env, seeker, "v:del:AgAD", 41);
  assert.equal(relayed().length, 3);
  assert.equal(relayed()[1].body.message.text, "/start video");
  assert.equal(relayed()[2].body.callback_query.data, "v:del:AgAD");
  assert.equal(sentTo(calls, 500).length, 0);
  assert.equal(calls.filter((c) => c.method === "answerCallbackQuery").length, 0);

  // Сервер недоступен: честно говорим, что профиль недоступен, а не показываем справку или приветствие
  up = false;
  await post(env, circle);
  assert.match(sentTo(calls, 500).at(-1).body.text, /Профиль сейчас недоступен/);
  await say(env, seeker, "/start video");
  assert.match(sentTo(calls, 500).at(-1).body.text, /Профиль сейчас недоступен/);
  await press(env, seeker, "v:del:AgAD", 42);
  assert.match(calls.filter((c) => c.method === "answerCallbackQuery").at(-1).body.text, /Профиль сейчас недоступен/);

  // Обычный /start серверу не передаётся
  const before = relayed().length;
  await say(env, seeker, "/start");
  assert.equal(relayed().length, before);
  assert.match(sentTo(calls, 500).at(-2).body.text, /Привет! Это бот vacante.kz/);

  // Обычное видео: сервер берёт его, только если у человека есть профиль, иначе отвечает бот
  const plain = { message: { chat, from: seeker, video: { file_id: "v", duration: 20 } } };
  up = true;
  await post(env, plain);
  assert.equal(relayed().at(-1).body.message.video.file_id, "v");
  const quiet = sentTo(calls, 500).length;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.vacante.kz/")) {
      calls.push({ method: "server", body: JSON.parse(init.body) });
      return Response.json({ ok: true, handled: false });
    }
    return telegram(url, init);
  };
  await post(env, plain);
  assert.equal(sentTo(calls, 500).length, quiet + 1);
  assert.doesNotMatch(sentTo(calls, 500).at(-1).body.text, /Профиль сейчас недоступен/);

  // /start video, как любая команда, прерывает анкету вакансии
  await say(env, seeker, "/vacancy");
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM dialogs WHERE chat_id = 500").n, 1);
  await say(env, seeker, "/start video");
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM dialogs WHERE chat_id = 500").n, 0);
});

test("/otkliki, /napominaniya и кнопки под напоминаниями отвечает сервер", async () => {
  const env = fakeEnv();
  const calls = [];
  const telegram = fakeFetch(calls);
  let up = true;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.vacante.kz/")) {
      calls.push({ method: "server", body: JSON.parse(init.body) });
      if (!up) throw new TypeError("fetch failed");
      return Response.json({ ok: true, handled: true });
    }
    return telegram(url, init);
  };
  const seeker = user(600, "Айгерим");
  const relayed = () => calls.filter((c) => c.method === "server");

  await say(env, seeker, "/vacancy");
  await say(env, seeker, "/otkliki");
  await say(env, seeker, "/napominaniya@vacantekz_bot");
  await press(env, seeker, "r:12:invited", 43);
  assert.deepEqual(
    relayed().map((c) => c.body.message?.text ?? c.body.callback_query.data),
    ["/otkliki", "/napominaniya@vacantekz_bot", "r:12:invited"],
  );
  // Команда прерывает анкету, а отвечает на неё сервер
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM dialogs WHERE chat_id = 600").n, 0);
  assert.equal(sentTo(calls, 600).length, 1); // только первый вопрос анкеты
  assert.equal(calls.filter((c) => c.method === "answerCallbackQuery").length, 0);

  // Сервер недоступен: так и говорим
  up = false;
  await say(env, seeker, "/otkliki");
  assert.match(sentTo(calls, 600).at(-1).body.text, /Профиль сейчас недоступен/);
  await press(env, seeker, "r:12:invited", 44);
  assert.match(calls.filter((c) => c.method === "answerCallbackQuery").at(-1).body.text, /Профиль сейчас недоступен/);

  // Похожие команды остаются боту
  up = true;
  const before = relayed().length;
  await say(env, seeker, "/otkliki_all");
  assert.equal(relayed().length, before);
});


test("жалоба из приложения: только с ключом сервера, уходит всем модераторам", async () => {
  const env = fakeEnv();
  const calls = [];
  globalThis.fetch = fakeFetch(calls);
  env.DB.prepare("INSERT INTO admins (chat_id) VALUES (?)").bind(900).run();
  const { serverKey } = await import("../src/server.js");
  const report = (key) =>
    worker.fetch(
      new Request("https://bot.example/internal/report", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: JSON.stringify({ vacancy_id: "x-1", title: "Бариста <b>", reason: "prepay", from: 7001 }),
      }),
      env,
      ctx,
    );
  assert.equal((await report("nope")).status, 403);
  const ok = await report(await serverKey(env.TELEGRAM_BOT_TOKEN));
  assert.equal(ok.status, 200);
  const msg = calls.find((c) => c.method === "sendMessage");
  assert.equal(msg.body.chat_id, 900);
  assert.match(msg.body.text, /просят предоплату/);
  assert.match(msg.body.text, /Бариста &lt;b&gt;/);
});

test("смена: /smena, «Беру смену», подтверждение, набор, отмена, напоминание и «кто пришёл»", async () => {
  const { shiftCron } = await import("../src/index.js");
  const shift = await import("../src/shift.js");
  const env = fakeEnv();
  const calls = [];
  globalThis.fetch = fakeFetch(calls);
  const boss = user(100, "Дана", "dana_cafe");
  const admin = user(900, "Мирас");
  const seeker = user(300, "Ерлан");
  const other = user(301, "Асель");
  await say(env, admin, "/admin");
  await say(env, boss, "/smena");
  assert.match(sentTo(calls, 100).at(-1).body.text, /людей на смену/);
  await press(env, boss, "jobcity:almaty");
  await say(env, boss, "Официант");
  await say(env, boss, "Кафе «Зерно»");
  const tomorrow = shift.localDay(new Date(), 1);
  const dates = sentTo(calls, 100).at(-1).body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(dates.includes(`jobdate:${tomorrow}`));
  await press(env, boss, "jobdate:2020-01-01"); // не из списка: ничего не меняет
  await press(env, boss, `jobdate:${tomorrow}`);
  await say(env, boss, "когда удобно");
  assert.match(sentTo(calls, 100).at(-1).body.text, /Не понял время/);
  await say(env, boss, "с 10 до 22");
  await say(env, boss, "12 000 ₸ за смену");
  await press(env, boss, "jobneed:1");
  await say(env, boss, "Абая, 10");
  await press(env, boss, "skip:details");
  const preview = calls.filter((c) => c.method === "editMessageText").at(-1).body.text;
  assert.match(preview, /Проверьте смену/);
  assert.match(preview, /⚡ <b>Смена: Официант<\/b>/);
  assert.match(preview, /10:00–22:00/);
  assert.match(preview, /👥 Нужно: 1 человек/);
  await press(env, boss, "jobsend");
  const saved = env.DB.get("SELECT * FROM jobs");
  assert.equal(saved.kind, "shift");
  assert.equal(saved.schedule, `Смена ${tomorrow.slice(8, 10)}.${tomorrow.slice(5, 7)}, 10:00–22:00`);
  assert.deepEqual([saved.shift_date, saved.shift_start, saved.shift_end, saved.need], [tomorrow, "10:00", "22:00", 1]);
  await press(env, admin, `mod:ok:${saved.id}`);

  // Кандидат берёт смену: номер кнопкой, работодатель видит надёжность и подтверждает
  await say(env, seeker, `/start take_${saved.id}`);
  assert.equal(sentTo(calls, 300).at(-1).body.reply_markup.keyboard[0][0].request_contact, true);
  await post(env, { message: { chat: { id: 300, type: "private" }, from: seeker, contact: { phone_number: "+77010000000" } } });
  const ask = sentTo(calls, 100).at(-1).body;
  assert.match(ask.text, /Хочет выйти на смену «Официант»/);
  assert.match(ask.text, /Ерлан, 📱 \+77010000000/);
  assert.match(ask.text, /новичок на vacante/);
  const appId = env.DB.get("SELECT id FROM applications").id;
  assert.equal(env.DB.get("SELECT name FROM pragma_table_info('applications') WHERE name = 'phone'"), null); // номер не храним
  await say(env, other, `/start take_${saved.id}`);
  await say(env, other, "Асель, 20 лет, +77020000000");
  const otherId = env.DB.get("SELECT id FROM applications WHERE chat_id = 301").id;

  await press(env, seeker, `sh:ok:${appId}`); // кандидат не может подтвердить сам себя
  assert.equal(env.DB.get("SELECT status FROM applications WHERE id = ?", appId).status, "asked");
  await press(env, boss, `sh:ok:${appId}`);
  assert.match(sentTo(calls, 300).at(-1).body.text, /Вас ждут на смене/);
  assert.match(sentTo(calls, 300).at(-1).body.text, /start=take_/);
  assert.equal(env.DB.get("SELECT status, closed_full FROM jobs").status, "closed"); // набрали 1 из 1
  assert.match(sentTo(calls, 100).at(-1).body.text, /набрали всех/);
  await press(env, boss, `sh:ok:${otherId}`);
  assert.equal(env.DB.get("SELECT status FROM applications WHERE id = ?", otherId).status, "asked");
  await say(env, user(302, "Нурлан"), `/start take_${saved.id}`);
  assert.match(sentTo(calls, 302).at(-1).body.text, /закрыта или набрана/);

  // Кандидат отменяет: смена снова открыта, работодатель предупреждён; второй подтверждён
  await press(env, seeker, `sh:cancel:${appId}`);
  assert.equal(env.DB.get("SELECT status FROM jobs").status, "approved");
  assert.match(sentTo(calls, 100).at(-1).body.text, /не сможет прийти/);
  await press(env, boss, `sh:ok:${otherId}`);
  assert.equal(env.DB.get("SELECT status FROM jobs").status, "closed");

  // Будильник: напоминание за 3 часа, после смены вопрос «кто пришёл»
  const { start, end } = shift.shiftTimes(saved);
  await shiftCron(env, new Date(start.getTime() - 2 * 3600e3));
  assert.match(sentTo(calls, 301).at(-1).body.text, /скоро смена/);
  const reminders = sentTo(calls, 301).length;
  await shiftCron(env, new Date(start.getTime() - 1 * 3600e3));
  assert.equal(sentTo(calls, 301).length, reminders); // второй раз не напоминаем
  await shiftCron(env, new Date(end.getTime() + 60e3));
  const att = sentTo(calls, 100).at(-1).body;
  assert.match(att.text, /Отметьте, кто пришёл/);
  assert.deepEqual(att.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [`att:1:${otherId}`, `att:0:${otherId}`]);
  await press(env, boss, `att:1:${otherId}`);
  assert.match(sentTo(calls, 301).at(-1).body.text, /засчитана! Ваша надёжность: вышел на 1 из 1 смены/);
  await shiftCron(env, new Date(end.getTime() + 2 * 3600e3));
  assert.equal(sentTo(calls, 100).filter((c) => /Отметьте, кто пришёл/.test(c.body.text)).length, 1);
});

test("профиль компании /company, ответы на вопросы о компании и кнопки «c:» ведёт сервер", async () => {
  const env = fakeEnv();
  const calls = [];
  const telegram = fakeFetch(calls);
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.vacante.kz/")) {
      calls.push({ method: "server", body: JSON.parse(init.body) });
      return Response.json({ ok: true, handled: true });
    }
    return telegram(url, init);
  };
  const boss = user(600, "Айгерим");
  const chat = { id: 600, type: "private" };
  const relayed = () => calls.filter((c) => c.method === "server");
  await say(env, boss, "/company");
  await post(env, { message: { chat, from: boss, text: "Greenwich, пр. Достык 111", reply_to_message: { text: "🏠 Новое заведение · Алматы\n…" } } });
  await press(env, boss, "c:add:5", 43);
  assert.equal(relayed().length, 3);
  assert.equal(relayed()[1].body.message.reply_to_message.text.slice(0, 2), "🏠");
  assert.equal(relayed()[2].body.callback_query.data, "c:add:5");
  assert.equal(sentTo(calls, 600).length, 0);
  // Ответ на другое сообщение бота — не серверу
  await post(env, { message: { chat, from: boss, text: "привет", reply_to_message: { text: "Как вас зовут?" } } });
  assert.equal(relayed().length, 3);
});

// initData, подписанные токеном бота, как их присылает Telegram в Mini App
function initData(token, user, authDate = Math.floor(Date.now() / 1000)) {
  const fields = { auth_date: String(authDate), query_id: "AAE", user: JSON.stringify(user) };
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

test("кабинет работодателя: вход по initData, вакансии, отклики, оплата и пакеты", async () => {
  const env = { ...fakeEnv(), KASPI_DETAILS: "+7 700 000 00 00, Мирас Б.", POST_PRICE: "990", BOOST_PRICE: "3990", BOOST_DAYS: "14",
    PACKS: "3:9990:60" };
  const calls = [];
  globalThis.fetch = fakeFetch(calls);
  await say(env, user(900, "Мирас"), "/admin");
  const call = (auth, method = "GET", body) => worker.fetch(new Request("https://bot.example/api/cabinet", {
    method, headers: { Authorization: `tma ${auth}`, Origin: "https://vacante.kz", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined }), env, ctx);
  const dana = initData(env.TELEGRAM_BOT_TOKEN, { id: 100, first_name: "Дана", username: "dana_cafe" });

  // Без подписи, с чужой подписью или старые данные: не пускаем
  assert.equal((await call("hash=0")).status, 401);
  assert.equal((await call(initData("2:other", { id: 100, first_name: "Дана" }))).status, 401);
  assert.equal((await call(initData(env.TELEGRAM_BOT_TOKEN, { id: 100, first_name: "Дана" }, 1000))).status, 401);
  const preflight = await worker.fetch(new Request("https://bot.example/api/cabinet", { method: "OPTIONS", headers: { Origin: "https://vacante.kz" } }), env, ctx);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "https://vacante.kz");

  env.DB.prepare(`INSERT INTO jobs (employer_chat, employer_name, status, city, title, company, salary, approved_at)
     VALUES (100, 'Дана', 'approved', 'almaty', 'Повар', 'Кафе', '300 000 ₸', datetime('now')),
            (100, 'Дана', 'payment', 'almaty', 'Бариста', 'Кафе', '250 000 ₸', NULL),
            (555, 'Чужой', 'approved', 'almaty', 'Курьер', 'Склад', '200 000 ₸', datetime('now'))`).run();
  env.DB.prepare("INSERT INTO applications (job_id, chat_id, notice_id) VALUES (1, 300, 77)").run();

  const res = await call(dana);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://vacante.kz");
  const state = await res.json();
  assert.deepEqual(state.jobs.map((j) => [j.id, j.status, j.applications]), [[2, "payment", 0], [1, "approved", 1]]);
  assert.deepEqual(state.jobs[0].pay, { amount: 990, tariff: "basic", waiting: false });
  assert.equal(state.jobs[1].url, "https://vacante.kz/v/bot-1/");
  assert.deepEqual(state.jobs[1].boost, { price: 3990, days: 14, shift: false, waiting: false });
  assert.deepEqual(state.tariffs, { post: 990, pro: 3990, days: 14, shift_pro: 1390, packs: [{ count: 3, price: 9990, days: 60 }] });
  assert.equal(state.kaspi, "+7 700 000 00 00, Мирас Б.");

  // Отклики приходят в чат ещё раз
  let r = await (await call(dana, "POST", { action: "apps", id: 1 })).json();
  assert.equal(r.message, "Отклики отправили вам в чат с ботом");
  assert.deepEqual(calls.at(-1), { method: "copyMessage", body: { chat_id: 100, from_chat_id: 100, message_id: 77 } });
  // Чужую вакансию не трогаем
  r = await call(dana, "POST", { action: "close", id: 3 });
  assert.equal(r.status, 400);
  assert.equal(env.DB.get("SELECT status FROM jobs WHERE id = 3").status, "approved");

  // «Я оплатил» за размещение и за Про: карточки модератору, сообщение в чат
  r = await (await call(dana, "POST", { action: "paid_post", id: 2 })).json();
  assert.match(r.message, /Сверяем перевод/);
  assert.equal(r.state.jobs[0].pay.waiting, true);
  assert.match(sentTo(calls, 900).at(-1).body.text, /Оплата размещения №1: <b>990 ₸<\/b>/);
  r = await (await call(dana, "POST", { action: "paid_boost", id: 1 })).json();
  assert.equal(r.state.jobs[1].boost.waiting, true);
  assert.match(sentTo(calls, 100).at(-1).body.text, /Сверяем перевод за вакансию №1/);
  assert.equal((await call(dana, "POST", { action: "paid_boost", id: 1 })).status, 400);  // второй раз: уже сверяем

  // Пакет: оплата, модератор подтверждает, Про из пакета
  r = await (await call(dana, "POST", { action: "paid_pack", count: 3 })).json();
  assert.equal(r.state.pack_waiting, true);
  const pack = env.DB.get("SELECT id FROM payments WHERE kind = 'pack'").id;
  await press(env, user(900, "Мирас"), `pay:ok:${pack}`, 5);
  env.DB.prepare("UPDATE payments SET status = 'rejected' WHERE job_id = 1").run();
  r = await (await call(dana, "POST", { action: "credit", id: 1 })).json();
  assert.match(r.message, /Тариф Про включён до \d\d\.\d\d/);
  assert.equal(r.state.credits, 2);
  assert.ok(r.state.jobs[1].pro_until);

  r = await (await call(dana, "POST", { action: "close", id: 1 })).json();
  assert.match(r.message, /закрыта/);
  assert.equal(env.DB.get("SELECT status FROM jobs WHERE id = 1").status, "closed");
});

test("вход на сайт через бота: код, подтверждение кнопкой, ключ для кабинета", async () => {
  const env = fakeEnv();
  const calls = [];
  globalThis.fetch = fakeFetch(calls);
  const api = (method, query = "") => worker.fetch(new Request(`https://bot.example/api/login${query}`,
    { method, headers: { Origin: "https://vacante.kz" } }), env, ctx);
  const cabinet = (auth) => worker.fetch(new Request("https://bot.example/api/cabinet",
    { headers: { Authorization: auth, Origin: "https://vacante.kz" } }), env, ctx);

  const start = await (await api("POST")).json();
  assert.match(start.code, /^[0-9a-f]{24}$/);
  assert.equal(start.link, `https://t.me/vacantekz_bot?start=login_${start.code}`);
  assert.deepEqual(await (await api("GET", `?code=${start.code}`)).json(), { pending: true });
  assert.equal((await api("GET", "?code=nope")).status, 410);

  // Бот спрашивает, человек подтверждает кнопкой
  const dana = user(100, "Дана");
  await say(env, dana, `/start login_${start.code}`);
  const ask = sentTo(calls, 100).at(-1).body;
  assert.match(ask.text, /Войти на сайт vacante.kz/);
  assert.deepEqual(ask.reply_markup.inline_keyboard[0][0], { text: "✅ Да, войти · Иә, кіру", callback_data: `login:${start.code}` });
  await press(env, dana, `login:${start.code}`, 9);
  assert.match(calls.at(-1).body.text, /Вход подтверждён/);
  // Второй раз тот же код не подтвердить, в том числе другому человеку
  await press(env, user(200, "Чужой"), `login:${start.code}`, 10);
  assert.match(calls.at(-1).body.text, /устарела/);

  const done = await (await api("GET", `?code=${start.code}`)).json();
  assert.deepEqual(done.user, { id: 100, first_name: "Дана" });
  assert.equal((await api("GET", `?code=${start.code}`)).status, 410);  // ключ выдаём один раз

  const ok = await cabinet(`session ${done.session}`);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).user.id, 100);
  const [body, mac] = done.session.split(".");
  assert.equal((await cabinet(`session ${body}.${"0".repeat(64)}`)).status, 401);
  assert.equal((await cabinet(`session ${mac}`)).status, 401);

  // Старый код не подтверждается
  const old = await (await api("POST")).json();
  await env.DB.prepare("UPDATE logins SET created_at = datetime('now', '-11 minutes') WHERE code = ?").bind(old.code).run();
  await say(env, dana, `/start login_${old.code}`);
  assert.match(sentTo(calls, 100).at(-1).body.text, /устарела/);
});

test("анкета работодателя: метка ссылки, должность кнопкой, «Я ищу работу» ведёт к вакансиям", async () => {
  const env = fakeEnv();
  const calls = [];
  globalThis.fetch = fakeFetch(calls);
  const boss = user(120, "Асель");
  await say(env, boss, "/start post_site");
  const first = sentTo(calls, 120).at(-1).body;
  assert.ok(first.reply_markup.inline_keyboard.some((row) => row[0].callback_data === "jobseeker"));
  assert.equal(env.DB.get("SELECT came_from FROM jobs WHERE employer_chat = 120").came_from, "site");
  await press(env, boss, "jobcity:astana", 5);
  const ask = calls.at(-1).body;
  assert.match(ask.text, /Нажмите кнопку или напишите свою должность/);
  assert.deepEqual(ask.reply_markup.inline_keyboard[0][0], { text: "Официант", callback_data: "jobtitle:0" });
  await press(env, boss, "jobtitle:1", 5);
  assert.deepEqual(env.DB.get("SELECT title, step FROM jobs WHERE employer_chat = 120"), { title: "Повар", step: "company" });
  await press(env, boss, "jobtitle:2", 5); // старая кнопка: должность уже выбрана
  assert.equal(env.DB.get("SELECT title FROM jobs WHERE employer_chat = 120").title, "Повар");

  // Соискатель по ссылке из канала о сменах: черновик убран, счётчик, кнопки к вакансиям и подписке
  const seeker = user(121, "Нурлан");
  await say(env, seeker, "/start smena_tg");
  assert.equal(env.DB.get("SELECT kind, came_from FROM jobs WHERE employer_chat = 121").kind, "shift");
  await press(env, seeker, "jobseeker", 6);
  const out = calls.at(-1).body;
  assert.match(out.text, /анкета для работодателей/);
  assert.equal(out.reply_markup.inline_keyboard[1][0].callback_data, "settings");
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM jobs WHERE employer_chat = 121").n, 0);
  assert.deepEqual(env.DB.get("SELECT came_from, n FROM role_switches"), { came_from: "tg", n: 1 });
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM dialogs WHERE chat_id = 121").n, 0);

  // Меню работодателя и старые ссылки тоже работают
  await say(env, user(122, "Ерлан"), "/start post_pf");
  assert.equal(env.DB.get("SELECT came_from FROM jobs WHERE employer_chat = 122").came_from, "profile");
  await say(env, user(123, "Дана"), "/start smena");
  assert.deepEqual(env.DB.get("SELECT kind, came_from FROM jobs WHERE employer_chat = 123"), { kind: "shift", came_from: null });
  await press(env, user(124, "Айдос"), "emp:vacancy");
  assert.equal(env.DB.get("SELECT came_from FROM jobs WHERE employer_chat = 124").came_from, "menu");
});

test("брошенная анкета: одно напоминание днём через час, «Продолжить» и «Не нужно»", async () => {
  const env = fakeEnv();
  const calls = [];
  globalThis.fetch = fakeFetch(calls);
  const boss = user(130, "Жанар");
  await say(env, boss, "/start post");
  await press(env, boss, "jobcity:almaty", 7);
  await say(env, user(131, "Тимур"), "/start post"); // ничего не выбрал: возможно, нажал случайно, не пишем
  // Одни и те же часы для базы и будильника: анкета брошена в 10:00, будильник в 12:00 и в 01:00 по Казахстану
  env.DB.prepare("UPDATE jobs SET updated_at = '2026-11-20 05:00:00', created_at = '2026-11-20 05:00:00'").run();
  const day = new Date("2026-11-20T07:00:00Z");
  const night = new Date("2026-11-20T20:00:00Z");
  assert.equal(await nudgeDrafts(env, night), 0);
  assert.equal(await nudgeDrafts(env, day), 1);
  assert.equal(await nudgeDrafts(env, day), 0); // только один раз
  const nudge = sentTo(calls, 130).at(-1).body;
  assert.match(nudge.text, /не закончили. Осталось 6 из 7 вопросов/);
  const id = env.DB.get("SELECT id FROM jobs WHERE employer_chat = 130").id;
  assert.deepEqual(nudge.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [`jobresume:${id}`, `jobdrop:${id}`]);

  // Ушёл в другую команду: диалога нет, «Продолжить» его возвращает на тот же вопрос
  await say(env, boss, "/myjobs");
  await press(env, boss, `jobresume:${id}`, 8);
  assert.match(calls.at(-1).body.text, /Вопрос 2 из 7<\/i>\nКого ищете/);
  await say(env, boss, "Бариста");
  assert.equal(env.DB.get("SELECT title FROM jobs WHERE id = ?", id).title, "Бариста");
  await press(env, user(999, "Чужой"), `jobresume:${id}`, 8);
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM dialogs WHERE chat_id = 999").n, 0);
  await press(env, boss, `jobdrop:${id}`, 8);
  assert.equal(env.DB.get("SELECT COUNT(*) AS n FROM jobs WHERE id = ?", id).n, 0);
});

test("быстрое размещение: текст в чат, ссылка на hh, город словами и вставка из кабинета", async () => {
  const env = fakeEnv();
  const calls = [];
  const tgFetch = fakeFetch(calls);
  globalThis.fetch = async (url, init) => {
    if (String(url) === "https://api.hh.ru/vacancies/777") {
      calls.push({ method: "hh", headers: init.headers });
      return Response.json({ name: "Кассир", employer: { name: "Магнум" }, area: { name: "Шымкент" },
        salary: { from: 230000, currency: "KZT" }, description: "<p>Работа на кассе</p>" });
    }
    if (String(url).startsWith("https://api.hh.ru/")) return new Response("nope", { status: 404 });
    return tgFetch(url, init);
  };
  const boss = user(140, "Самал");
  await say(env, boss, "/start post_site");
  assert.match(sentTo(calls, 140).at(-1).body.text, /вставьте сюда текст вакансии или ссылку/);
  await say(env, boss, "Требуется повар в кафе «Арман»\nЗарплата: 15 000 тг за смену\nАлматы, мкр Самал-2\nПитание");
  const after = sentTo(calls, 140).at(-1).body.text;
  assert.match(after, /Заполнил анкету из вашего текста/);
  assert.match(after, /Проверьте вакансию/); // всё нашлось: сразу предпросмотр
  assert.deepEqual(env.DB.get("SELECT city, title, company, salary, schedule, step FROM jobs WHERE employer_chat = 140"),
    { city: "almaty", title: "Повар", company: "кафе «Арман»", salary: "15 000 тг за смену", schedule: "", step: null });

  // Ссылка на hh: берём из официального API, спрашиваем только недостающее
  const hr = user(141, "Ерке");
  await say(env, hr, "/vacancy");
  await say(env, hr, "https://shymkent.hh.kz/vacancy/777");
  assert.equal(calls.find((c) => c.method === "hh").headers["HH-User-Agent"], "vacante.kz/1.0 (bot)");
  assert.deepEqual(env.DB.get("SELECT city, title, company, salary, details, step FROM jobs WHERE employer_chat = 141"),
    { city: "shymkent", title: "Кассир", company: "Магнум", salary: "от 230 000 ₸ в месяц", details: "Работа на кассе", step: null });
  await say(env, hr, "/vacancy");
  await say(env, hr, "https://hh.kz/vacancy/404");
  assert.match(sentTo(calls, 141).at(-1).body.text, /Не получилось открыть ссылку/);
  await say(env, hr, "https://www.olx.kz/d/obyavlenie/x");
  assert.match(sentTo(calls, 141).at(-1).body.text, /Эту ссылку открыть не могу/);
  await say(env, hr, "в Астане");
  assert.match(sentTo(calls, 141).at(-1).body.text, /Кого ищете/);
  // Длинная должность на вопросе «Кого ищете?» — обычный ответ
  await say(env, hr, "Продавец-консультант в магазин строительных материалов и инструментов");
  assert.deepEqual(env.DB.get("SELECT title, step FROM jobs WHERE employer_chat = 141"),
    { title: "Продавец-консультант в магазин строительных материалов и инструментов", step: "company" });

  // Кабинет в приложении: вставка уходит в бот, недостающее спросит чат
  const call = (body) => worker.fetch(new Request("https://bot.example/api/cabinet", {
    method: "POST", headers: { Authorization: `tma ${initData(env.TELEGRAM_BOT_TOKEN, { id: 142, first_name: "Алия" })}`,
      Origin: "https://vacante.kz", "Content-Type": "application/json" }, body: JSON.stringify(body) }), env, ctx);
  const short = await (await call({ action: "paste", text: "повар" })).json();
  assert.match(short.error, /Вставьте текст вакансии/);
  // Неудачная вставка не трогает начатую в боте анкету
  await say(env, user(142, "Алия"), "/vacancy");
  await press(env, user(142, "Алия"), "jobcity:astana", 9);
  const bad = await (await call({ action: "paste", text: "https://www.olx.kz/d/obyavlenie/vakansiya" })).json();
  assert.match(bad.error, /Эту ссылку открыть не могу/);
  assert.deepEqual(env.DB.get("SELECT city, step FROM jobs WHERE employer_chat = 142"), { city: "astana", step: "title" });
  assert.equal(env.DB.get("SELECT mode FROM dialogs WHERE chat_id = 142").mode, "post");
  const ok = await (await call({ action: "paste", text: "Нужен грузчик на склад\nОплата 10 000 тг в день\nг. Караганда" })).json();
  assert.match(ok.message, /проверьте её в чате с ботом/);
  assert.deepEqual(env.DB.get("SELECT city, title, salary, came_from, step FROM jobs WHERE employer_chat = 142"),
    { city: "karaganda", title: "Грузчик на склад", salary: "10 000 тг в день", came_from: "app", step: "company" });
  assert.match(sentTo(calls, 142).at(-1).body.text, /Заполнил анкету[\s\S]*Как называется заведение/);
  await say(env, user(142, "Алия"), "Склад «Восток»");
  assert.match(sentTo(calls, 142).at(-1).body.text, /Проверьте вакансию/);
});

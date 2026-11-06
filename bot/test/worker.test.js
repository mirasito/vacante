import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { moderationKey } from "../src/employer.js";
import worker from "../src/index.js";
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
  assert.match(sentTo(calls, 100).at(-1).body.text, /опубликована, откликов: 1/);
  await press(env, boss, `close:${job.id}`, 31);
  assert.equal(env.DB.get("SELECT status FROM jobs").status, "closed");
  await say(env, user(301, "Асель"), `/start apply_${job.id}`);
  assert.match(sentTo(calls, 301).at(-1).body.text, /уже закрыта/);
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
  assert.match(sentTo(calls, 100).at(-1).body.text, /\/vacancy: разместить вакансию/);
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
  assert.match(approved.text, /«🔥 Срочно» за 3 000 ₸/);
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
  assert.match(card.text, /Оплата «Срочно» №1: <b>3 000 ₸<\/b>/);
  assert.deepEqual(card.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["pay:ok:1", "pay:no:1"]);

  await press(env, stranger, "pay:ok:1");
  assert.equal(env.DB.get("SELECT boost_until FROM jobs").boost_until, null);
  await press(env, admin, "pay:ok:1", 41);
  const boosted = env.DB.get("SELECT boost_until, julianday(boost_until) - julianday('now') AS left FROM jobs");
  assert.ok(boosted.left > 6.99 && boosted.left < 7.01);
  assert.match(sentTo(calls, 100).at(-1).body.text, /Оплата получена/);
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
  assert.match(mine.reply_markup.inline_keyboard[0][0].text, /Продлить «Срочно» №1: 3 000 ₸/);
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
  assert.match(preview.text, /Размещение стоит <b>900 ₸<\/b>/);
  assert.match(preview.reply_markup.inline_keyboard[0][0].text, /к оплате: 900 ₸/);

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

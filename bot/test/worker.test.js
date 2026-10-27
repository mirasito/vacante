import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

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
  return { DB: testDB(), TELEGRAM_BOT_TOKEN: "1:test", SITE_URL: "https://vacante.kz", CHANNELS: "@vacanteastana,@vacantealmaty" };
}

// Поддельный Telegram: запоминает вызовы, админом канала считается только пользователь 900
function fakeFetch(calls) {
  return async (url, init) => {
    if (String(url).endsWith("/feed.json")) {
      return Response.json({ vacancies: [{ id: "a", city: "almaty", category: "horeca", perks: [], pay: 0, html: "<b>Бариста</b>" }] });
    }
    const method = String(url).split("/").pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    if (method === "getChatMember") {
      return Response.json({ ok: true, result: { status: body.user_id === 900 ? "creator" : "left" } });
    }
    return Response.json({ ok: true, result: {} });
  };
}

async function post(env, update, secret) {
  const headers = { "X-Telegram-Bot-Api-Secret-Token": secret ?? (await webhookSecret(env.TELEGRAM_BOT_TOKEN)) };
  return worker.fetch(new Request("https://bot.example/telegram", { method: "POST", headers, body: JSON.stringify(update) }), env);
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
  assert.match(calls[0].body.text, /Где ищете работу/);
  for (const data of ["city:almaty", "go:perks", "done"]) await press(env, me, data);
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
  assert.match(preview.text, /<b>Официант<\/b>\n🏢 Кафе «Зерно»\n📍 Алматы\n💰 12 000 ₸ за смену\n🕒 2\/2/);
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
  assert.match(calls.filter((c) => c.method === "editMessageText").at(-1).body.text, /Уже опубликована/);

  // Отклик: ссылка из карточки на сайте, номер кнопкой «Отправить мой номер»
  await say(env, candidate, `/start apply_${job.id}`);
  const intro = sentTo(calls, 300).at(-1).body;
  assert.match(intro.text, /Отклик на вакансию/);
  assert.equal(intro.reply_markup.keyboard[0][0].request_contact, true);
  await post(env, { message: { chat: { id: 300, type: "private" }, from: candidate, contact: { phone_number: "+77010000000" } } });
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
  assert.match(sentTo(calls, 100).at(-1).body.text, /уже 3 вакансии на проверке/);

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

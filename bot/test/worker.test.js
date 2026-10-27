import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../src/index.js";
import { webhookSecret } from "../src/logic.js";

// Поддельные D1 и Telegram: проверяем весь путь от вебхука до ответа бота
function fakeEnv() {
  const rows = new Map();
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => rows.get(args[0]) ?? null,
            run: async () => {
              const [chat_id, city, categories, perks, min_pay, active] = args;
              rows.set(chat_id, { chat_id, city, categories, perks, min_pay, active });
            },
          };
        },
      };
    },
  };
  return { env: { DB, TELEGRAM_BOT_TOKEN: "1:test", SITE_URL: "https://vacante.kz" }, rows };
}

function fakeFetch(calls) {
  return async (url, init) => {
    if (String(url).endsWith("/feed.json")) {
      return Response.json({ vacancies: [{ id: "a", city: "almaty", category: "horeca", perks: [], pay: 0, html: "<b>Бариста</b>" }] });
    }
    calls.push({ method: String(url).split("/").pop(), body: JSON.parse(init.body) });
    return Response.json({ ok: true });
  };
}

async function post(env, update, secret) {
  const headers = { "X-Telegram-Bot-Api-Secret-Token": secret ?? (await webhookSecret(env.TELEGRAM_BOT_TOKEN)) };
  return worker.fetch(new Request("https://bot.example/telegram", { method: "POST", headers, body: JSON.stringify(update) }), env);
}

test("от /start до «Готово» и первых примеров", async () => {
  const { env, rows } = fakeEnv();
  const calls = [];
  globalThis.fetch = fakeFetch(calls);
  const chat = { id: 7, type: "private" };
  await post(env, { message: { chat, text: "/start" } });
  assert.equal(calls[0].method, "sendMessage");
  assert.match(calls[0].body.text, /Где ищете работу/);
  const message = { chat, message_id: 1 };
  for (const data of ["city:almaty", "go:perks", "done"]) {
    await post(env, { callback_query: { id: "q", message, data } });
  }
  assert.deepEqual(rows.get(7), { chat_id: 7, city: "almaty", categories: "", perks: "", min_pay: 0, active: 1 });
  const last = calls.at(-1);
  assert.equal(last.method, "sendMessage");
  assert.equal(last.body.text, "Вот последние подходящие:\n\n<b>Бариста</b>");
  await post(env, { message: { chat, text: "/stop" } });
  assert.equal(rows.get(7).active, 0);
});

test("чужие запросы без секрета отклоняются", async () => {
  const { env } = fakeEnv();
  const res = await post(env, { message: { chat: { id: 1, type: "private" }, text: "/start" } }, "wrong");
  assert.equal(res.status, 403);
});

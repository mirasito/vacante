// Вход с сайта вне Telegram: ключ, который выдаёт бот (bot/src/login.js), сервер принимает как initData.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

// Ключ делаем тем же кодом, что и бот на Cloudflare: так тест ловит расхождение форматов
// @ts-expect-error: бот написан на JavaScript без описаний типов
import { makeSession as botSession } from "../../bot/src/login.js";
import { verifySession } from "../src/telegram.ts";
import { NOW, startServer, TOKEN, type TestServer } from "./helpers.ts";

const makeSession = botSession as (token: string, user: { id: number; first_name: string }, nowMs: number) => Promise<string>;

let s: TestServer;
before(async () => {
  s = await startServer();
});
after(() => s.close());

test("ключ входа бота: верный принимается, чужой, испорченный и просроченный — нет", async () => {
  const key = await makeSession(TOKEN, { id: 7301, first_name: "Ерлан" }, NOW);
  assert.deepEqual(verifySession(key, TOKEN, NOW), { id: 7301, first_name: "Ерлан" });
  assert.equal(verifySession(key, "999:other-token", NOW), null);
  assert.equal(verifySession(`${key}x`, TOKEN, NOW), null);
  assert.equal(verifySession(key.replace(/^./, (c) => (c === "e" ? "f" : "e")), TOKEN, NOW), null);
  assert.equal(verifySession(`${key}.extra`, TOKEN, NOW), null);
  assert.equal(verifySession("", TOKEN, NOW), null);
  assert.equal(verifySession(key, TOKEN, NOW + 31 * 86400_000), null);  // 30 дней прошли
});

test("/me с ключом входа сайта: тот же человек, что в Telegram", async () => {
  const key = await makeSession(TOKEN, { id: 7302, first_name: "Дана" }, NOW);
  const r = await s.call("GET", "/me", { headers: { authorization: `session ${key}` } });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.id, 7302);
  assert.equal(r.json.user.first_name, "Дана");
  const bad = await s.call("GET", "/me", { headers: { authorization: "session abc.def" } });
  assert.equal(bad.status, 401);
});

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { crmApi, crmKey } from "../src/crm.js";

function testDB() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  const plain = (row) => (row ? { ...row } : null);
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    first: async () => plain(db.prepare(sql).get(...args)),
    all: async () => ({ results: db.prepare(sql).all(...args).map(plain) }),
    run: async () => (db.prepare(sql).run(...args), { success: true }),
  });
  return { prepare: (sql) => statement(sql) };
}

const env = () => ({ DB: testDB(), ADMIN_PASSWORD: "secret", SITE_URL: "https://vacante.kz" });

async function call(e, method, { body, password = "secret", origin = "https://vacante.kz", now } = {}) {
  const headers = { Origin: origin, Authorization: `Bearer ${await crmKey(password)}`, "Content-Type": "application/json" };
  const req = new Request("https://bot.example/api/crm", { method, headers, body: body && JSON.stringify(body) });
  return crmApi(req, e, now);
}

test("статус и заметка сохраняются, дата контакта ставится при смене статуса", async () => {
  const e = env();
  let r = await call(e, "POST", { body: { venue: "almaty:зерно", status: "sent" }, now: new Date("2026-10-28T10:00:00Z") });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "https://vacante.kz");
  r = await call(e, "POST", { body: { venue: "almaty:зерно", note: "написал в Instagram" }, now: new Date("2026-10-28T11:00:00Z") });
  assert.equal((await r.json()).contacted_at, "2026-10-28T10:00:00.000Z");  // заметка дату не двигает
  await call(e, "POST", { body: { venue: "almaty:зерно", status: "replied" }, now: new Date("2026-10-29T09:00:00Z") });
  const { marks } = await (await call(e, "GET")).json();
  assert.deepEqual(marks["almaty:зерно"], {
    status: "replied", note: "написал в Instagram", contacted_at: "2026-10-29T09:00:00.000Z", updated_at: "2026-10-29T09:00:00.000Z",
  });
});

test("чужой пароль, неизвестный статус и предзапрос CORS", async () => {
  const e = env();
  assert.equal((await call(e, "GET", { password: "wrong" })).status, 403);
  assert.equal((await call(e, "POST", { body: { venue: "almaty:x", status: "spam" } })).status, 400);
  const pre = await crmApi(new Request("https://bot.example/api/crm", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), e);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("Access-Control-Allow-Origin"), "https://vacante.kz");
  assert.equal((await call({ ...e, ADMIN_PASSWORD: undefined }, "GET")).status, 503);
});

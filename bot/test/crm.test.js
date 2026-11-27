import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { cleanTries, crmApi, crmKey, jobsApi } from "../src/crm.js";

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

test("вкладка «Работодатели»: кто разместил, статус, отклики и оплаты, только с паролем", async () => {
  const e = env();
  await e.DB.prepare("INSERT INTO jobs (employer_chat, employer_name, status, city, title, company, salary) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(42, "Айгуль (@aigul)", "approved", "almaty", "Повар", "Зерно", "300 000").run();
  await e.DB.prepare("INSERT INTO jobs (employer_chat, employer_name, status) VALUES (?, ?, ?)").bind(43, "Ерлан", "draft").run();
  await e.DB.prepare("INSERT INTO applications (job_id, chat_id) VALUES (1, 7), (1, 8)").run();
  await e.DB.prepare("INSERT INTO payments (job_id, employer_chat, amount, days, status) VALUES (1, 42, 3000, 7, 'confirmed'), (1, 42, 3000, 7, 'pending')").run();
  const req = (password) => new Request("https://bot.example/api/jobs", {
    headers: { Origin: "https://vacante.kz", Authorization: `Bearer ${password}` },
  });
  assert.equal((await jobsApi(req("wrong"), e)).status, 403);
  const r = await jobsApi(req(await crmKey("secret")), e);
  assert.equal(r.status, 200);
  const { jobs } = await r.json();
  assert.deepEqual(jobs.map((j) => [j.id, j.employer_name, j.status]), [[2, "Ерлан", "draft"], [1, "Айгуль (@aigul)", "approved"]]);
  assert.equal(jobs[1].applications, 2);
  assert.equal(jobs[1].paid, 3000);
  assert.equal(jobs[1].employer_chat, 42);
  assert.equal(jobs[1].came_from, null);  // 'profile' — пришёл со страницы профиля кандидата
});

test("подбор пароля: после 10 неверных ключей с адреса 429 до конца окна, даже с верным; другой адрес не задет", async () => {
  const e = env();
  const at = (min) => new Date(Date.UTC(2026, 10, 27, 8, min));
  const ask = async (password, ip, now) => {
    const headers = { Origin: "https://vacante.kz", Authorization: `Bearer ${await crmKey(password)}`, "CF-Connecting-IP": ip };
    return crmApi(new Request("https://bot.example/api/crm", { headers }), e, now);
  };
  for (let i = 0; i < 10; i++) assert.equal((await ask(`guess${i}`, "1.2.3.4", at(0))).status, 403);
  const blocked = await ask("secret", "1.2.3.4", at(1));
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("Retry-After")) > 0);
  assert.match((await blocked.json()).error, /попробуйте через 14 мин/);
  // /api/jobs тем же счётчиком
  const jobs = await jobsApi(new Request("https://bot.example/api/jobs", {
    headers: { Authorization: `Bearer ${await crmKey("secret")}`, "CF-Connecting-IP": "1.2.3.4" },
  }), e, at(2));
  assert.equal(jobs.status, 429);
  assert.equal((await ask("secret", "5.6.7.8", at(2))).status, 200);
  // Блокированный адрес больше не пишет в базу: счётчик стоит на 10
  assert.equal((await e.DB.prepare("SELECT wrong FROM admin_tries WHERE ip = ?").bind("1.2.3.4").first()).wrong, 10);
  // Окно кончилось: верный пароль снова проходит, неверный начинает счёт заново
  assert.equal((await ask("secret", "1.2.3.4", at(15))).status, 200);
  assert.equal((await ask("nope", "1.2.3.4", at(16))).status, 403);
  assert.deepEqual(await e.DB.prepare("SELECT start, wrong FROM admin_tries WHERE ip = ?").bind("1.2.3.4").first(),
    { start: at(16).getTime() / 1000, wrong: 1 });
  // Часовая чистка убирает только счётчики с кончившимся окном
  await e.DB.prepare("INSERT INTO admin_tries (ip, start, wrong) VALUES ('9.9.9.9', ?, 3)").bind(at(0).getTime() / 1000).run();
  await cleanTries(e, at(20));
  const left = (await e.DB.prepare("SELECT ip FROM admin_tries ORDER BY ip").all()).results.map((r) => r.ip);
  assert.deepEqual(left, ["1.2.3.4"]);
});

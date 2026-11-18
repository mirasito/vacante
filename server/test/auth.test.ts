import assert from "node:assert/strict";
import { test } from "node:test";

import type { Ctx } from "../src/app.ts";
import { adminGuard, bearer, internalGuard, sameKey } from "../src/auth.ts";
import { openDb } from "../src/db.ts";
import { HttpError, type Request } from "../src/http.ts";
import { internalKey } from "../src/telegram.ts";
import { TOKEN } from "./helpers.ts";

const req = (authorization?: string, ip = "203.0.113.7") =>
  ({
    path: "/admin/seekers",
    header: (n: string) =>
      n === "authorization" ? authorization : n === "x-forwarded-for" ? ip : n === "user-agent" ? "Mozilla/5.0 test" : undefined,
  }) as Request;
let clock = Date.parse("2026-11-18T08:00:00Z");
const ctx = (crmKey?: string, db = openDb(":memory:")) => ({ config: { botToken: TOKEN, crmKey }, db, now: () => clock }) as unknown as Ctx;
const logins = (c: Ctx) => c.db.prepare("SELECT result, ip, ua, path FROM admin_logins ORDER BY id").all().map((r) => ({ ...r }));
const fails = (fn: () => void, status: number, message: string) =>
  assert.throws(fn, (e: unknown) => e instanceof HttpError && e.status === status && e.message === message);

test("ключ из заголовка и сравнение ключей", () => {
  assert.equal(bearer(req("Bearer abc")), "abc");
  assert.equal(bearer(req()), "");
  assert.ok(sameKey("abc", "abc") && sameKey("abc", Buffer.from("abc")));
  assert.ok(!sameKey("abd", "abc") && !sameKey("ab", "abc") && !sameKey("", "abc"));
});

test("внутренний ключ: только ключ из токена бота", () => {
  const check = internalGuard(ctx());
  check(req(`Bearer ${internalKey(TOKEN)}`));
  fails(() => check(req("Bearer чужой")), 403, "Нет доступа");
  fails(() => check(req()), 403, "Нет доступа");
});

test("пароль админки: 503 без секрета, 403 при неверном", () => {
  fails(() => adminGuard(ctx())(req("Bearer x")), 503, "Админка не настроена: нет секрета ADMIN_PASSWORD");
  fails(() => adminGuard(ctx(), "CRM")(req("Bearer x")), 503, "CRM не настроена: нет секрета ADMIN_PASSWORD");
  const check = adminGuard(ctx("пароль"));
  check(req("Bearer пароль"));
  fails(() => check(req("Bearer не тот")), 403, "Неверный пароль админки");
});

test("журнал входов: неверные попытки пишутся, верная — раз в шесть часов, подбор блокируется", () => {
  const c = ctx("пароль");
  const check = adminGuard(c);
  check(req("Bearer пароль"));
  check(req("Bearer пароль"));  // второй запрос той же сессии в журнал не идёт
  for (let i = 0; i < 10; i++) fails(() => check(req("Bearer подбор", "198.51.100.9")), 403, "Неверный пароль админки");
  // Одиннадцатая попытка с того же адреса: пароль даже верный не проверяется
  fails(() => check(req("Bearer пароль", "198.51.100.9")), 429, "Слишком много неверных попыток, попробуйте через 15 минут");
  check(req("Bearer пароль"));  // другой адрес работает
  const rows = logins(c);
  assert.deepEqual(rows[0], { result: "ok", ip: "203.0.113.7", ua: "Mozilla/5.0 test", path: "/admin/seekers" });
  assert.equal(rows.filter((r) => r.result === "wrong").length, 10);
  assert.equal(rows.filter((r) => r.result === "blocked").length, 1);
  assert.equal(rows.filter((r) => r.result === "ok").length, 1);
  // Через 15 минут блокировка снимается, через 6 часов верный вход пишется снова
  clock += 15 * 60_000;
  check(req("Bearer пароль", "198.51.100.9"));
  clock += 6 * 60 * 60_000;
  check(req("Bearer пароль"));
  assert.equal(logins(c).filter((r) => r.result === "ok").length, 3);
});

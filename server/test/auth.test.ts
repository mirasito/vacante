import assert from "node:assert/strict";
import { test } from "node:test";

import type { Ctx } from "../src/app.ts";
import { adminGuard, bearer, internalGuard, sameKey } from "../src/auth.ts";
import { HttpError, type Request } from "../src/http.ts";
import { internalKey } from "../src/telegram.ts";
import { TOKEN } from "./helpers.ts";

const req = (authorization?: string) => ({ header: (n: string) => (n === "authorization" ? authorization : undefined) }) as Request;
const ctx = (crmKey?: string) => ({ config: { botToken: TOKEN, crmKey } }) as unknown as Ctx;
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

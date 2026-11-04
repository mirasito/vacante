import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { verifyInitData } from "../src/telegram.ts";
import { TOKEN, count, startServer, type TestServer } from "./helpers.ts";

// deploy/smoke.py проверяет после каждой выкладки вход из приложения на настоящем сервере.
// Здесь он идёт к тестовому серверу: подпись, CORS и ответ /me должны совпасть с тем, что ждёт проверка
const smoke = fileURLToPath(new URL("../deploy/smoke.py", import.meta.url));
const run = promisify(execFile);
const env = { ...process.env, TELEGRAM_BOT_TOKEN: TOKEN };

let s: TestServer;
before(async () => {
  // Проверка подписывает данные входа текущим временем, поэтому и сервер живёт по настоящим часам
  s = await startServer({ now: () => Date.now() });
});
after(() => s.close());

test("данные входа от проверки после выкладки подписаны так же, как в Telegram", async () => {
  const { stdout } = await run("python3", [smoke, "--init-data"], { env });
  const data = verifyInitData(stdout.trim(), TOKEN, Date.now());
  assert.ok(data);
  // Такого пользователя в Telegram быть не может: у настоящих id не длиннее 52 бит
  assert.equal(data.user.id, Number.MAX_SAFE_INTEGER);
  assert.ok(data.user.id >= 2 ** 52);
});

test("проверка после выкладки проходит на рабочем сервере и ничего не записывает", async () => {
  const { stdout } = await run("python3", [smoke, `http://127.0.0.1:${s.port}`], { env });
  assert.match(stdout, /Вход из приложения работает/);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM seekers"), 0);
});

test("проверка после выкладки замечает чужой токен бота", async () => {
  await assert.rejects(
    run("python3", [smoke, `http://127.0.0.1:${s.port}`], { env: { ...env, TELEGRAM_BOT_TOKEN: "999:another-token-another-token-xx" } }),
    (err: { stdout?: string }) => /не принял подпись Telegram/.test(err.stdout ?? ""),
  );
});

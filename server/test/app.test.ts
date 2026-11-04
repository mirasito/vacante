import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { AIGERIM, count, initDataFor, startServer, type TestServer } from "./helpers.ts";

let s: TestServer;
before(async () => {
  s = await startServer();
});
after(() => s.close());

test("/health отвечает на обоих адресах", async () => {
  for (const host of ["api.vacante.kz", "p.vacante.kz"]) {
    const r = await s.call("GET", "/health", { host });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, version: "test" });
  }
});

test("чужой хост не обслуживаем", async () => {
  const r = await s.call("GET", "/health", { host: "evil.example" });
  assert.equal(r.status, 404);
});

test("/me без входа через Telegram — 401", async () => {
  const r = await s.call("GET", "/me");
  assert.equal(r.status, 401);
  const bad = await s.call("GET", "/me", { headers: { authorization: "tma hash=00" } });
  assert.equal(bad.status, 401);
});

test("/me называет вошедшего и ничего не записывает", async () => {
  const r = await s.call("GET", "/me", { headers: { authorization: `tma ${initDataFor(AIGERIM)}` } });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.first_name, "Айгерим");
  assert.equal(r.json.user.id, 7001);
  assert.equal(r.json.profile, false);
  assert.equal(r.json.open, false);
  // До согласия о человеке ничего не записываем
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM seekers"), 0);
});

test("CORS только для сайта, где лежит Mini App", async () => {
  const pre = await s.call("OPTIONS", "/me", {
    headers: { origin: "https://vacante.kz", "access-control-request-headers": "authorization" },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers["access-control-allow-origin"], "https://vacante.kz");
  assert.match(String(pre.headers["access-control-allow-headers"]), /Authorization/);

  const ok = await s.call("GET", "/me", {
    headers: { origin: "https://vacante.kz", authorization: `tma ${initDataFor(AIGERIM)}` },
  });
  assert.equal(ok.headers["access-control-allow-origin"], "https://vacante.kz");

  const evil = await s.call("GET", "/me", { headers: { origin: "https://evil.example" } });
  assert.equal(evil.headers["access-control-allow-origin"], undefined);
});

test("неизвестный путь и метод", async () => {
  assert.equal((await s.call("GET", "/nope")).status, 404);
  assert.equal((await s.call("DELETE", "/health")).status, 405);
});

test("страницы профиля закрыты от поисковиков", async () => {
  const r = await s.call("GET", "/health", { host: "p.vacante.kz" });
  assert.match(String(r.headers["x-robots-tag"]), /noindex/);
  assert.equal(r.headers["referrer-policy"], "no-referrer");
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { USER_AGENT } from "../src/olx.ts";
import { internalKey } from "../src/telegram.ts";
import { startServer, TOKEN } from "./helpers.ts";

test("сбор OLX: только с ключом, только два пути, честный User-Agent, статус OLX в заголовке", async () => {
  const asked: { url: string; ua: string | null }[] = [];
  let status = 200;
  let clock = Date.parse("2026-11-05T06:00:00Z");
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    asked.push({ url: String(url), ua: new Headers(init?.headers).get("user-agent") });
    return new Response(JSON.stringify({ data: [{ id: 1 }] }), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const s = await startServer({ fetch: fetchImpl, now: () => clock });
  const headers = { authorization: `Bearer ${internalKey(TOKEN)}` };
  try {
    assert.equal((await s.call("GET", "/internal/olx/api/v1/offers/?limit=50")).status, 403);
    assert.equal((await s.call("GET", "/internal/olx/api/v1/users/me/", { headers })).status, 404);
    assert.equal((await s.call("GET", "/internal/olx/api/v1/offers/?q=x", { headers })).status, 400);

    const ok = await s.call("GET", "/internal/olx/api/v1/offers/?category_id=6&offset=0&limit=50&sort_by=created_at:desc", { headers });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["x-olx-status"], "200");
    assert.deepEqual(ok.json, { data: [{ id: 1 }] });
    assert.equal(asked[0]!.url, "https://www.olx.kz/api/v1/offers/?category_id=6&offset=0&limit=50&sort_by=created_at%3Adesc");
    assert.equal(asked[0]!.ua, USER_AGENT);

    // Чаще раза в 3 секунды OLX не спрашиваем
    assert.equal((await s.call("GET", "/internal/olx/api/v1/categories/", { headers })).status, 429);
    clock += 3000;
    status = 403;
    const blocked = await s.call("GET", "/internal/olx/api/v1/categories/", { headers });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.headers["x-olx-status"], "403");
    assert.equal(asked.length, 2);
  } finally {
    await s.close();
  }
});

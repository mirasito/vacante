import assert from "node:assert/strict";
import { test } from "node:test";

import { wakeUpdate } from "../src/cron.js";

const NOW = Date.parse("2026-10-27T13:25:00Z");
const env = { GH_DISPATCH_TOKEN: "gh-test", GITHUB_REPO: "mirasito/vacante" };

function fakeGitHub(lastRunAt, calls, dispatchStatus = 204) {
  return async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body, auth: init.headers.Authorization });
    if (url.includes("/runs")) {
      return Response.json({ workflow_runs: lastRunAt ? [{ created_at: lastRunAt }] : [] });
    }
    return new Response(null, { status: dispatchStatus });
  };
}

test("без токена ничего не делает", async () => {
  assert.equal(await wakeUpdate({ GITHUB_REPO: "mirasito/vacante" }, NOW, async () => assert.fail()), "no-token");
});

test("свежий запуск был: не трогает", async () => {
  const calls = [];
  assert.equal(await wakeUpdate(env, NOW, fakeGitHub("2026-10-27T13:17:40Z", calls)), "recent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/mirasito/vacante/actions/workflows/update.yml/runs?per_page=1");
  assert.equal(calls[0].auth, "Bearer gh-test");
});

test("GitHub проспал: запускает update.yml на main", async () => {
  const calls = [];
  assert.equal(await wakeUpdate(env, NOW, fakeGitHub("2026-10-27T12:16:00Z", calls)), "dispatched");
  assert.equal(calls[1].url, "https://api.github.com/repos/mirasito/vacante/actions/workflows/update.yml/dispatches");
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(JSON.parse(calls[1].body), { ref: "main" });
});

test("ошибка GitHub видна в логах воркера", async () => {
  await assert.rejects(wakeUpdate(env, NOW, fakeGitHub(null, [], 403)), /GitHub dispatch: 403/);
});

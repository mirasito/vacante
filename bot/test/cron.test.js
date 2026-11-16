import assert from "node:assert/strict";
import { test } from "node:test";

import { wakeDaily, wakeUpdate } from "../src/cron.js";

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

// Утренние workflow (ролики, черновик поста): расписание GitHub их пропускало, запускает только будильник
const day = (runs) => async (url, init = {}) => {
  runs.calls.push({ url, method: init.method ?? "GET", body: init.body });
  if (url.includes("/runs")) {
    const name = url.match(/workflows\/([\w.-]+)\/runs/)[1];
    return Response.json({ workflow_runs: (runs[name] ?? []).map((created_at) => ({ created_at })) });
  }
  return new Response(null, { status: 204 });
};
const dispatched = (runs) => runs.calls.filter((c) => c.method === "POST").map((c) => c.url.match(/workflows\/([\w.-]+)\//)[1]);

test("утро: в 7:25 по Казахстану будильник запускает ролики и черновик поста", async () => {
  const runs = { calls: [] };
  assert.deepEqual(await wakeDaily(env, Date.parse("2026-11-17T02:25:00Z"), day(runs)), { "video.yml": "dispatched", "draft.yml": "dispatched" });
  assert.deepEqual(dispatched(runs), ["video.yml", "draft.yml"]);
  assert.deepEqual(JSON.parse(runs.calls.find((c) => c.method === "POST").body), { ref: "main" });
});

test("утро: до 7:25 рано, после полудня поздно — не запускает", async () => {
  for (const at of ["2026-11-17T01:25:00Z", "2026-11-17T08:25:00Z", "2026-11-17T23:25:00Z"]) {
    const runs = { calls: [] };
    assert.deepEqual(await wakeDaily(env, Date.parse(at), day(runs)), { "video.yml": "not-due", "draft.yml": "not-due" });
    assert.equal(runs.calls.length, 0);
  }
});

test("утро: сегодня уже запускали — второй раз не шлёт; вчерашний запуск не считается", async () => {
  const runs = { calls: [], "video.yml": ["2026-11-17T02:25:30Z"], "draft.yml": ["2026-11-16T05:53:00Z"] };
  assert.deepEqual(await wakeDaily(env, Date.parse("2026-11-17T03:25:00Z"), day(runs)), { "video.yml": "done", "draft.yml": "dispatched" });
  assert.deepEqual(dispatched(runs), ["draft.yml"]);
});

test("утро: сбой одного workflow не мешает другому; без токена ничего не делает", async () => {
  const runs = { calls: [] };
  const flaky = async (url, init) => (url.includes("video.yml") ? new Response(null, { status: 500 }) : day(runs)(url, init));
  assert.deepEqual(await wakeDaily(env, Date.parse("2026-11-17T02:25:00Z"), flaky), { "video.yml": "error: GitHub runs: 500", "draft.yml": "dispatched" });
  assert.equal(await wakeDaily({ GITHUB_REPO: "mirasito/vacante" }, Date.parse("2026-11-17T02:25:00Z"), async () => assert.fail()), "no-token");
});

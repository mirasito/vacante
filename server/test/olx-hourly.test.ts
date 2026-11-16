import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { loadConfig } from "../src/config.ts";
import { collectOlx, lastOlxRun, parseAd, parseListing, startOlxHourly } from "../src/olx-hourly.ts";
import { PAUSE_MS, USER_AGENT } from "../src/olx.ts";
import { internalKey } from "../src/telegram.ts";
import { NOW, startServer, TOKEN } from "./helpers.ts";

// Объявление так, как оно лежит в window.__PRERENDERED_STATE__ страницы https://www.olx.kz/rabota/
const ad = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  url: `https://www.olx.kz/d/obyavlenie/rabota/povar-ID${id}.html`,
  title: "Требуется повар",
  description: "Кафе в центре.<br>График 2/2. Звоните +7 777 123 45 67",
  isJob: true,
  isActive: true,
  createdTime: "2026-11-03T10:00:00+05:00",
  lastRefreshTime: "2026-11-04T09:00:00+05:00",
  salary: { from: 250000, to: 300000, period: "monthly", currencyCode: "KZT", negotiable: false },
  location: { cityName: "Алматы", regionName: "Алматинская область" },
  map: { lat: 43.2389, lon: 76.8897, show_detailed: true },
  user: { name: "Анна" },
  ...extra,
});

/** Страница рубрики: состояние лежит строкой JSON внутри скрипта, после него идут другие скрипты. */
const page = (number: number, ads: unknown[], totalPages = 2) => {
  const state = { listing: { listing: { pageNumber: number - 1, totalPages, ads } } };
  return `<!doctype html><html><body><div id="root"></div><script>window.__PRERENDERED_STATE__= ${JSON.stringify(JSON.stringify(state))};
    window.__TAURUS__= {"x":"}\\"{"};</script><script>var a = "{";</script></body></html>`;
};

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html" } });

test("страница OLX разбирается в строки для импорта, лишнее отсеивается", () => {
  const ads = [
    ad(1),
    ad(2, { isJob: false }),
    ad(3, { isActive: false }),
    ad(4, { url: "https://www.olx.kz/d/obyavlenie/prodam-divan-ID4.html" }),
    ad(5, { id: "5" }),
    ad(6, { description: null }),
    ad(7, { createdTime: "2026-10-01T10:00:00+05:00" }), // старше 14 дней
    ad(8, { createdTime: "2026-11-05T10:00:00+05:00" }), // из будущего
    ad(9, { url: "https://www.olx.kz/obyavlenie/rabota/barista-ID9.html", salary: null, location: null }),
    "строка",
  ];
  const listing = parseListing(page(1, ads, 7), 1);
  assert.equal(listing.totalPages, 7);
  assert.equal(listing.ads.length, 10);
  const rows = listing.ads.map((a) => parseAd(a, NOW)).filter(Boolean);
  assert.deepEqual(rows.map((r) => r!.id), [1, 9]);
  assert.deepEqual(rows[0], {
    id: 1,
    url: "https://www.olx.kz/d/obyavlenie/rabota/povar-ID1.html",
    title: "Требуется повар",
    description: "Кафе в центре.<br>График 2/2. Звоните +7 777 123 45 67",
    created_time: "2026-11-03T05:00:00.000Z",
    last_refresh_time: "2026-11-04T09:00:00+05:00",
    map: { lat: 43.2389, lon: 76.8897, show_detailed: true },
    salary: { from: 250000, to: 300000, type: "monthly", currency: "KZT", arranged: false },
    city: "Алматы",
  });
  assert.equal(rows[1]!.city, undefined);

  // Состояние объектом, а не строкой, тоже читается
  const plain = `<script>window.__PRERENDERED_STATE__ = ${JSON.stringify({ listing: { listing: { pageNumber: 0, totalPages: 1, ads: [] } } })};</script>`;
  assert.deepEqual(parseListing(plain, 1), { ads: [], totalPages: 1 });

  assert.throws(() => parseListing("<html>Подтвердите, что вы не робот</html>", 1));
  assert.throws(() => parseListing(page(1, [ad(1)]), 2)); // OLX отдал не ту страницу
  assert.throws(() => parseListing('<script>window.__PRERENDERED_STATE__= "{\\"listing\\":{}}";</script>', 1));
  assert.throws(() => parseListing('<script>window.__PRERENDERED_STATE__= "{оборвано', 1));
});

test("403 на первой странице: один запрос, статус HTTP 403, ничего не записано", async () => {
  const s = await startServer();
  const asked: string[] = [];
  const slept: number[] = [];
  try {
    const fetchImpl = (async (url: string | URL) => {
      asked.push(String(url));
      return html("Forbidden", 403);
    }) as typeof fetch;
    const run = await collectOlx({ db: s.db, now: () => NOW, fetch: fetchImpl }, async (ms) => void slept.push(ms));
    assert.deepEqual(run, { at: new Date(NOW).toISOString(), status: "HTTP 403", pages: 0, stored: 0, inserted: 0 });
    assert.deepEqual(asked, ["https://www.olx.kz/rabota/"]);
    assert.deepEqual(slept, []);
    assert.deepEqual(lastOlxRun(s.db), run);
    assert.equal((s.db.prepare("SELECT count(*) AS n FROM olx_ads").get() as { n: number }).n, 0);
  } finally {
    await s.close();
  }
});

test("две страницы записаны с паузой между ними, честный запрос, итог виден по /internal/olx/hourly", async () => {
  const s = await startServer();
  const log: string[] = [];
  try {
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("user-agent"), USER_AGENT);
      assert.equal(headers.get("accept"), "text/html");
      assert.equal(headers.get("cookie"), null);
      assert.equal(init?.redirect, "manual");
      log.push(String(url));
      return String(url).endsWith("?page=2") ? html(page(2, [ad(2), ad(3, { description: "Отклик на OLX" })])) : html(page(1, [ad(1), ad(2), ad(50, { isJob: false })]));
    }) as typeof fetch;
    const sleep = async (ms: number) => void log.push(`пауза ${ms}`);
    const key = { authorization: `Bearer ${internalKey(TOKEN)}` };

    assert.equal((await s.call("GET", "/internal/olx/hourly")).status, 403);
    assert.deepEqual((await s.call("GET", "/internal/olx/hourly", { headers: key })).json, { enabled: true, pages_max: 5, every_minutes: 60, last: null });

    const run = await collectOlx({ db: s.db, now: () => NOW, fetch: fetchImpl }, sleep);
    assert.deepEqual(run, { at: new Date(NOW).toISOString(), status: "ok", pages: 2, stored: 3, inserted: 3 });
    assert.deepEqual(log, ["https://www.olx.kz/rabota/", `пауза ${PAUSE_MS}`, "https://www.olx.kz/rabota/?page=2"]);

    const rows = s.db.prepare("SELECT id, phone, description, city, salary FROM olx_ads ORDER BY id").all() as Record<string, unknown>[];
    assert.deepEqual(rows.map((r) => r.id), [1, 2, 3]);
    // Телефон только из текста объявления: хранится отдельно, в описании его нет
    assert.equal(rows[0]!.phone, "+77771234567");
    assert.doesNotMatch(String(rows[0]!.description), /777/);
    assert.equal(rows[2]!.phone, null);
    assert.equal(rows[0]!.city, "Алматы");
    assert.equal(rows[0]!.salary, JSON.stringify({ from: 250000, to: 300000, currency: "KZT", type: "monthly", arranged: false }));
    assert.doesNotMatch(JSON.stringify(rows), /Анна/);

    // Часовой сбор на GitHub видит их там же, где объявления облачного агента
    const feed = await s.call("GET", "/internal/olx/imports", { headers: key });
    assert.deepEqual(feed.json.data.map((x: { id: number }) => x.id), [1, 2, 3]);
    assert.equal(feed.json.data[0].has_phone, true);

    // Повторный проход новых не добавляет
    const again = await collectOlx({ db: s.db, now: () => NOW + 3_600_000, fetch: fetchImpl }, sleep);
    assert.equal(again.stored, 3);
    assert.equal(again.inserted, 0);
    assert.deepEqual((await s.call("GET", "/internal/olx/hourly", { headers: key })).json.last, again);
  } finally {
    await s.close();
  }
});

test("капча на второй странице и молчание OLX: остановка без повторов, первая страница остаётся", async () => {
  const s = await startServer();
  try {
    let asked = 0;
    const captcha = (async (url: string | URL) => {
      asked++;
      return String(url).includes("page=") ? html("<html>Подтвердите, что вы не робот</html>") : html(page(1, [ad(1)], 3));
    }) as typeof fetch;
    const run = await collectOlx({ db: s.db, now: () => NOW, fetch: captcha }, async () => {});
    assert.deepEqual([run.status, run.pages, run.stored, asked], ["bad page", 1, 1, 2]);

    asked = 0;
    const silent = (async () => {
      asked++;
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as typeof fetch;
    const late = await collectOlx({ db: s.db, now: () => NOW, fetch: silent }, async () => {});
    assert.deepEqual([late.status, late.pages, asked], ["timeout", 0, 1]);

    asked = 0;
    const moved = (async () => {
      asked++;
      return new Response(null, { status: 302, headers: { location: "https://www.olx.kz/captcha" } });
    }) as typeof fetch;
    const redirected = await collectOlx({ db: s.db, now: () => NOW, fetch: moved }, async () => {});
    assert.deepEqual([redirected.status, asked], ["HTTP 302", 1]);
  } finally {
    await s.close();
  }
});

test("OLX_HOURLY=0 выключает сбор; включённый не ходит на OLX чаще раза в час", async () => {
  const env = { TELEGRAM_BOT_TOKEN: TOKEN };
  assert.equal(loadConfig(env).olxHourly, true);
  assert.equal(loadConfig({ ...env, OLX_HOURLY: "1" }).olxHourly, true);
  assert.equal(loadConfig({ ...env, OLX_HOURLY: "0" }).olxHourly, false);
  assert.equal(loadConfig({ ...env, OLX_HOURLY: "false" }).olxHourly, false);

  const off = await startServer({}, { OLX_HOURLY: "0" });
  const on = await startServer();
  try {
    let asked = 0;
    const fetchImpl = (async () => {
      asked++;
      return html("Forbidden", 403);
    }) as typeof fetch;
    const stopOff = startOlxHourly({ config: off.config, db: off.db, now: () => NOW, fetch: fetchImpl }, 0, 5);
    await delay(60);
    stopOff();
    assert.equal(asked, 0);
    assert.equal(lastOlxRun(off.db), null);
    const status = await off.call("GET", "/internal/olx/hourly", { headers: { authorization: `Bearer ${internalKey(TOKEN)}` } });
    assert.equal(status.json.enabled, false);

    // Таймер проверяет каждые 5 мс, но час с прошлой попытки не прошёл: запрос один
    const stopOn = startOlxHourly({ config: on.config, db: on.db, now: () => NOW, fetch: fetchImpl }, 0, 5);
    await delay(60);
    stopOn();
    assert.equal(asked, 1);
    assert.equal(lastOlxRun(on.db)?.status, "HTTP 403");
  } finally {
    await off.close();
    await on.close();
  }
});

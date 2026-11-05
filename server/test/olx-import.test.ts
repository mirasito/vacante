import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { bookmarklet } from "../src/olx-import.ts";
import { internalKey } from "../src/telegram.ts";
import { NOW, startServer, TOKEN } from "./helpers.ts";

const PASSWORD = "секрет-админки";
// Так же ключ считает выкладка (server.yml) и страница /olx/ в браузере
const KEY = createHash("sha256").update("olx:" + PASSWORD).digest("hex");

const ad = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  url: `https://www.olx.kz/d/obyavlenie/povar-ID${id}.html`,
  title: "Требуется повар",
  description: "Кафе в центре.<br>График 2/2. Звоните +7 777 123 45 67, hr@cafe.kz",
  created_time: "2026-11-04T10:00:00+05:00",
  last_refresh_time: "2026-11-04T10:00:00+05:00",
  offer_type: "offer",
  salary: { from: 250000, to: 300000, currency: "KZT", type: "monthly", arranged: false },
  city: "Алматы",
  map: { lat: 43.2389, lon: 76.8897, show_detailed: true },
  // Закладка этого не берёт, но даже если пришлёт, в базу не попадает
  user: { name: "Анна" },
  contact: { phone: true, name: "Анна" },
  ...extra,
});

test("страница /olx/ с закладкой: закладка ничего у OLX не запрашивает", async () => {
  const s = await startServer({}, { OLX_IMPORT_KEY: KEY });
  try {
    const page = await s.call("GET", "/olx/");
    assert.equal(page.status, 200);
    assert.equal(page.headers["x-robots-tag"], "noindex, nofollow");
    assert.match(page.text, /href="javascript:/);
    assert.match(page.text, /PRERENDERED_STATE/);
    assert.match(page.text, /id="paste" contenteditable="true"/); // путь без закладки: скопированная страница
    assert.match(page.text, /window\.vacanteFromHtml = fromHtml/);
    const code = decodeURIComponent(bookmarklet("https://api.vacante.kz/olx/").slice("javascript:".length));
    assert.match(code, /const PAGE = "https:\/\/api\.vacante\.kz\/olx\/", ORIGIN = "https:\/\/api\.vacante\.kz"/);
    assert.match(code, /window\.open\(PAGE, "vacante-olx"\)/);
    assert.match(code, /postMessage\(payload, ORIGIN\)/);
    assert.doesNotMatch(code, /fetch\(|XMLHttpRequest|\.src\s*=/);
    assert.doesNotMatch(code, /user|contact|phone/);
  } finally {
    await s.close();
  }
});

test("импорт: только с ключом, без телефонов и имён, повторы и чужое отсеиваются, выдача для сбора", async () => {
  const s = await startServer({}, { OLX_IMPORT_KEY: KEY });
  const headers = { authorization: `Bearer ${KEY}` };
  try {
    assert.equal((await s.call("POST", "/olx/import", { body: { items: [ad(1)] } })).status, 403);
    const wrong = { authorization: `Bearer ${"0".repeat(64)}` };
    assert.equal((await s.call("POST", "/olx/import", { headers: wrong, body: { items: [ad(1)] } })).status, 403);
    assert.equal((await s.call("POST", "/olx/import", { headers, body: { items: "x" } })).status, 400);

    const items = [
      ad(1),
      ad(1), // повтор в одном запросе
      ad(2, { offer_type: "seek" }), // резюме
      ad(3, { url: "https://evil.example/x" }),
      { id: "x", url: "https://www.olx.kz/d/obyavlenie/x.html", title: "Повар" },
      ad(4, { title: "  " }),
      ad(5, { created_time: "2020-01-01T00:00:00Z", salary: { arranged: true }, map: { lat: "a" }, city: 7 }),
    ];
    const r = await s.call("POST", "/olx/import", { headers, body: { items } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { received: 7, stored: 2, skipped: 5, total: 2 });

    const rows = s.db.prepare("SELECT * FROM olx_ads ORDER BY id").all() as Record<string, unknown>[];
    assert.deepEqual(rows.map((x) => x.id), [1, 5]);
    assert.match(String(rows[0]!.description), /^Кафе в центре\.\nГрафик 2\/2\./);
    assert.doesNotMatch(JSON.stringify(rows), /777|hr@|Анна/);
    assert.equal(rows[0]!.created_time, "2026-11-04T05:00:00.000Z");
    assert.equal(rows[1]!.created_time, null); // дата шестилетней давности не похожа на правду
    assert.equal(rows[1]!.salary, null);
    assert.equal(rows[1]!.city, null);

    // Повторный импорт того же объявления обновляет текст и дату импорта, а дата появления остаётся
    const again = await s.call("POST", "/olx/import", { headers, body: { items: [ad(1, { title: "Повар в кафе" })] } });
    assert.deepEqual(again.json, { received: 1, stored: 1, skipped: 0, total: 2 });
    assert.equal((s.db.prepare("SELECT title FROM olx_ads WHERE id = 1").get() as { title: string }).title, "Повар в кафе");

    assert.equal((await s.call("GET", "/internal/olx/imports")).status, 403);
    const internal = { authorization: `Bearer ${internalKey(TOKEN)}` };
    const feed = await s.call("GET", "/internal/olx/imports?since=2026-11-04T00:00:00Z", { headers: internal });
    assert.equal(feed.status, 200);
    const [first, second] = feed.json.data;
    assert.equal(first.id, 1);
    assert.equal(first.url, "https://www.olx.kz/d/obyavlenie/povar-ID1.html");
    assert.equal(first.title, "Повар в кафе");
    assert.equal(first.offer_type, "offer");
    assert.deepEqual(first.params, [
      { key: "salary", name: "Зарплата", type: "salary", value: { from: 250000, to: 300000, currency: "KZT", type: "monthly", arranged: false } },
    ]);
    assert.deepEqual(first.location, { city: { name: "Алматы" } });
    assert.deepEqual(first.map, { lat: 43.2389, lon: 76.8897, show_detailed: true });
    assert.equal(first.created_time, "2026-11-04T05:00:00.000Z");
    assert.equal(second.id, 5);
    assert.equal(second.created_time, new Date(NOW).toISOString()); // нет даты OLX: считаем от импорта
    assert.deepEqual(second.params, []);
    assert.deepEqual(second.location, {});
    assert.equal(second.map, null);
    assert.doesNotMatch(JSON.stringify(feed.json), /777|hr@|Анна/);

    const later = new Date(NOW + 1000).toISOString();
    const none = await s.call("GET", `/internal/olx/imports?since=${later}`, { headers: internal });
    assert.deepEqual(none.json.data, []);
  } finally {
    await s.close();
  }
});

test("без секрета ADMIN_PASSWORD импорт выключен", async () => {
  const s = await startServer();
  try {
    const r = await s.call("POST", "/olx/import", { headers: { authorization: `Bearer ${KEY}` }, body: { items: [] } });
    assert.equal(r.status, 503);
    assert.equal((await s.call("GET", "/olx/")).status, 200); // страница с инструкцией всё равно открывается
  } finally {
    await s.close();
  }
});

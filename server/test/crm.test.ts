import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { internalKey } from "../src/telegram.ts";
import { startServer, TOKEN } from "./helpers.ts";

const PASSWORD = "секрет-админки";
// Так же ключ считают админка в браузере, воркер бота и выкладка (server.yml)
const KEY = createHash("sha256").update("crm:" + PASSWORD.normalize("NFKC")).digest("hex");
const internal = { authorization: `Bearer ${internalKey(TOKEN)}` };
const admin = { authorization: `Bearer ${KEY}`, origin: "https://vacante.kz" };

const vacancy = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: "Бариста", category: "horeca", salary: "250 000 ₸/мес", source: "hh", posted_at: "2026-11-05T10:00:00+00:00",
  ...extra,
});

const greenwich = (vacancies: Record<string, unknown[]>) => ({
  key: "greenwich",
  name: "Greenwich",
  venues: [
    { key: "almaty:greenwich", name: "Greenwich", city: "almaty", address: "пр. Достык, 111", lat: 43.23, lon: 76.95,
      instagram: "greenwich.kz", avatar: "0123456789abcdef.jpg", twogis: "https://2gis.kz/almaty/search/Greenwich",
      agent_status: "found", vacancies: vacancies.almaty ?? [] },
    { key: "astana:greenwich", name: "Greenwich", city: "astana", vacancies: vacancies.astana ?? [] },
  ],
});

test("CRM: снимок с GitHub раскладывается по работодателям и заведениям, снятые вакансии уходят в архив", async () => {
  const s = await startServer({}, { CRM_KEY: KEY });
  try {
    const first = await s.call("POST", "/internal/crm/import", {
      headers: internal,
      body: { run_at: "2026-11-06T10:00:00Z", employers: [greenwich({ almaty: [vacancy("hh-1"), vacancy("tg-2", { source: "telegram" })], astana: [vacancy("bot-3", { source: "bot" })] })] },
    });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, { employers: 1, venues: 2, vacancies: 3 });
    let done = await s.call("POST", "/internal/crm/finish", { headers: internal, body: { run_at: "2026-11-06T10:00:00Z" } });
    assert.deepEqual(done.json, { archived: 0, employers: 1, venues: 2, active: 3 });

    // Через час tg-2 сняли с сайта: в снимке его нет
    await s.call("POST", "/internal/crm/import", {
      headers: internal,
      body: { run_at: "2026-11-06T11:00:00Z", employers: [greenwich({ almaty: [vacancy("hh-1")], astana: [vacancy("bot-3", { source: "bot" })] })] },
    });
    done = await s.call("POST", "/internal/crm/finish", { headers: internal, body: { run_at: "2026-11-06T11:00:00Z" } });
    assert.equal((done.json as { archived: number }).archived, 1);

    const list = await s.call("GET", "/admin/crm", { headers: admin });
    assert.equal(list.status, 200);
    assert.equal(list.headers["access-control-allow-origin"], "https://vacante.kz");
    const row = (list.json as { employers: Record<string, unknown>[] }).employers[0]!;
    assert.equal(row.name, "Greenwich");
    assert.equal(row.venues, 2);
    assert.equal(row.active, 2);
    assert.equal(row.total, 3);
    assert.deepEqual([...(row.cities as string[])].sort(), ["almaty", "astana"]);
    assert.equal(row.instagram, "greenwich.kz");

    const card = await s.call("GET", `/admin/crm/${row.id}`, { headers: admin });
    assert.equal(card.status, 200);
    const { employer, venues } = card.json as { employer: { name: string }; venues: Record<string, unknown>[] };
    assert.equal(employer.name, "Greenwich");
    const almaty = venues.find((v) => v.city === "almaty")!;
    assert.equal(almaty.address, "пр. Достык, 111");
    assert.deepEqual((almaty.vacancies as { id: string }[]).map((v) => v.id), ["hh-1"]);
    assert.deepEqual((almaty.archive as { id: string }[]).map((v) => v.id), ["tg-2"]);
    assert.equal(almaty.archived, 1);
  } finally {
    await s.close();
  }
});

test("CRM: без ключа ни импорта, ни просмотра; мусор в снимке отбрасывается", async () => {
  const s = await startServer({}, { CRM_KEY: KEY });
  try {
    assert.equal((await s.call("POST", "/internal/crm/import", { body: { run_at: "2026-11-06T10:00:00Z", employers: [] } })).status, 403);
    assert.equal((await s.call("GET", "/admin/crm", { headers: { authorization: `Bearer ${internalKey(TOKEN)}` } })).status, 403);
    assert.equal((await s.call("GET", "/admin/crm")).status, 403);
    assert.equal((await s.call("POST", "/internal/crm/import", { headers: internal, body: { employers: [] } })).status, 400);

    const r = await s.call("POST", "/internal/crm/import", {
      headers: internal,
      body: {
        run_at: "2026-11-06T10:00:00Z",
        employers: [
          { key: "", name: "Без ключа", venues: [{ key: "almaty:x", name: "X", vacancies: [] }] },
          { key: "cafe", name: "Кафе", venues: [] },
          { key: "dino", name: "DINO FEST", venues: [{ key: "almaty:dino", name: "DINO FEST", website: "javascript:alert(1) x", avatar: "../x.jpg",
            vacancies: [vacancy("v1", { source: "evil" }), vacancy("v2", { posted_at: "вчера" }), vacancy("v3")] }] },
        ],
      },
    });
    assert.deepEqual(r.json, { employers: 1, venues: 1, vacancies: 1 });
    const venue = s.db.prepare("SELECT website, avatar FROM venues WHERE key = 'almaty:dino'").get() as Record<string, unknown>;
    assert.equal(venue.website, null);
    assert.equal(venue.avatar, null);
  } finally {
    await s.close();
  }
});

test("CRM: без секрета ADMIN_PASSWORD админка получает понятную ошибку", async () => {
  const s = await startServer();
  try {
    const r = await s.call("GET", "/admin/crm", { headers: admin });
    assert.equal(r.status, 503);
  } finally {
    await s.close();
  }
});

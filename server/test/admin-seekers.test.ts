import assert from "node:assert/strict";
import { after, test } from "node:test";

import { AIGERIM, initDataFor, NOW, startServer, type TestServer } from "./helpers.ts";

const KEY = "cd".repeat(32);
const admin = { authorization: `Bearer ${KEY}` };
const ANKETA = {
  name: "Айгерим",
  city: "almaty",
  district: null,
  roles: ["Бариста"],
  experience: "1to3",
  employment: ["shifts"],
  pay_from: 250000,
  pay_period: "month",
  start: "week",
  phone: "+77012345678",
  languages: ["ru"],
};
const CONSENT = { version: "2026-11-04.2", adult: true, base: false };

const started: TestServer[] = [];
after(async () => {
  for (const s of started) await s.close().catch(() => undefined);
});

test("админка видит заполненные профили с телефоном и откликами, без дома и только с паролем", async () => {
  const s = await startServer({ now: () => NOW }, { CRM_KEY: KEY, PROFILES_OPEN: "1" });
  started.push(s);
  const auth = { authorization: `tma ${initDataFor(AIGERIM, NOW / 1000 - 60)}` };
  const put = await s.call("PUT", "/me/profile", { headers: auth, body: { profile: ANKETA, consent: CONSENT } });
  assert.equal(put.status, 201, JSON.stringify(put.json));

  assert.equal((await s.call("GET", "/admin/seekers")).status, 403);
  assert.equal((await s.call("GET", "/admin/seekers", { headers: { authorization: "Bearer nope" } })).status, 403);

  const r = await s.call("GET", "/admin/seekers", { headers: admin });
  assert.equal(r.status, 200);
  assert.equal(r.json.seekers.length, 1);
  const one = r.json.seekers[0];
  assert.equal(one.name, "Айгерим");
  assert.equal(one.city, "Алматы");
  assert.equal(one.phone, "+7 701 234 56 78");
  assert.equal(one.experience, "1–3 года");
  assert.equal(one.sent, 0);
  assert.equal(one.photo, false);
  assert.equal(one.video, null);
  assert.equal("lat" in one || "home_lat" in one, false);

  const apps = await s.call("GET", `/admin/seekers/${one.id}/applications`, { headers: admin });
  assert.deepEqual(apps.json, { applications: [] });
  assert.equal((await s.call("GET", `/admin/seekers/${one.id}/applications`)).status, 403);
  assert.equal((await s.call("GET", `/admin/seekers/${one.id}/photo.jpg`, { headers: admin })).status, 404);
  assert.equal((await s.call("GET", `/admin/seekers/${one.id}/video.mp4`)).status, 403);
  await s.close();
});

test("без секрета админки список закрыт", async () => {
  const s = await startServer();
  started.push(s);
  assert.equal((await s.call("GET", "/admin/seekers", { headers: admin })).status, 503);
  await s.close();
});

// Короткая анкета перезапуска: согласие, имя и профессии. Опыт, график и выход — потом, по желанию.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { applicationText } from "../src/applications.ts";
import { parseProfile, strength } from "../src/profile.ts";
import { AIGERIM, BROWSER, initDataFor, startServer, type TestServer } from "./helpers.ts";

const CONSENT = { version: "2026-11-04.2", adult: true, base: false };
const QUICK = { name: "Айдана", city: "almaty", roles: ["Бариста"] };
const FULL = { ...QUICK, experience: "1to3", employment: ["shifts"], start: "week" };
const auth = { authorization: `tma ${initDataFor(AIGERIM)}` };
const profileHost = { host: "p.vacante.kz" };

const started: TestServer[] = [];
after(async () => {
  for (const s of started) await s.close().catch(() => undefined);
});
async function server() {
  const s = await startServer({}, { PROFILES_OPEN: "1" });
  started.push(s);
  return s;
}

test("короткая анкета: достаточно имени, города и профессии", () => {
  const p = parseProfile(QUICK);
  assert.equal(p.experience, null);
  assert.deepEqual(p.employment, []);
  assert.equal(p.start, null);
  assert.equal(parseProfile({ ...QUICK, experience: null, employment: [], start: "" }).start, null);
});

test("короткая анкета: без имени, без профессий или с чужим значением — ошибка", () => {
  assert.throws(() => parseProfile({ ...QUICK, name: " " }), /name/);
  assert.throws(() => parseProfile({ ...QUICK, roles: [] }), /профессию/);
  assert.throws(() => parseProfile({ ...QUICK, experience: "много" }), /experience/);
  assert.throws(() => parseProfile({ ...QUICK, start: "вчера" }), /start/);
});

test("полная анкета разбирается как раньше", () => {
  const p = parseProfile(FULL);
  assert.deepEqual([p.experience, p.employment, p.start], ["1to3", ["shifts"], "week"]);
});

test("текст отклика из короткой анкеты: без пустых фраз и двойных пробелов", () => {
  const { text } = applicationText(parseProfile(QUICK), "Бариста", "https://p.vacante.kz/abc", false, "ru");
  assert.equal(text, "Здравствуйте! Пишу по вакансии «Бариста». Меня зовут Айдана.");
  const full = applicationText(parseProfile(FULL), "Бариста", "https://p.vacante.kz/abc", false, "ru").text;
  assert.equal(full, "Здравствуйте! Пишу по вакансии «Бариста». Меня зовут Айдана. Опыт 1–3 года. Могу выйти на этой неделе.");
});

test("сила профиля: короткая анкета первым делом просит опыт и график, полная — как раньше", () => {
  assert.deepEqual(strength(parseProfile(QUICK), { video: false, photo: false }), { percent: 25, next: "details" });
  assert.deepEqual(strength(parseProfile(FULL), { video: false, photo: false }), { percent: 45, next: "video" });
});

test("короткая анкета сохраняется, читается обратно и дополняется до полной", async () => {
  const s = await server();
  const created = await s.call("PUT", "/me/profile", { headers: auth, body: { profile: QUICK, consent: CONSENT } });
  assert.equal(created.status, 201);
  assert.deepEqual(
    [created.json.profile.experience, created.json.profile.employment, created.json.profile.start],
    [null, [], null],
  );
  assert.equal(created.json.strength.next, "details");
  const read = await s.call("GET", "/me/profile", { headers: auth });
  assert.equal(read.json.profile.experience, null);
  const filled = await s.call("PUT", "/me/profile", { headers: auth, body: { profile: FULL } });
  assert.equal(filled.status, 200);
  assert.equal(filled.json.profile.experience, "1to3");
  assert.equal(filled.json.strength.next, "video");
});

test("страница короткого профиля для работодателя: без пустых строк и слов undefined, null", async () => {
  const s = await server();
  await s.call("PUT", "/me/profile", { headers: auth, body: { profile: QUICK, consent: CONSENT } });
  const code = (await s.call("POST", "/me/link", { headers: auth })).json.code;
  const page = await s.call("GET", `/${code}`, { ...profileHost, headers: { "user-agent": BROWSER } });
  assert.equal(page.status, 200);
  assert.match(page.text, /Айдана/);
  assert.match(page.text, /Бариста/);
  assert.doesNotMatch(page.text, /undefined|>null<|<dd><\/dd>/);
  for (const label of ["Опыт", "График", "Может выйти"]) assert.doesNotMatch(page.text, new RegExp(`<dt>${label}</dt>`));
});

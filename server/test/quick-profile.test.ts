// Короткая анкета перезапуска: согласие, имя и профессии. Опыт, график и выход — потом, по желанию.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { applicationText } from "../src/applications.ts";
import { videoScript } from "../src/labels.ts";
import { CONSENT_VERSION, parseProfile, strength } from "../src/profile.ts";
import { AIGERIM, BROWSER, initDataFor, NOW, startServer, type TestServer } from "./helpers.ts";

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

test("сила профиля: и короткая, и полная анкета первым делом просят опыт работы и навыки", () => {
  assert.deepEqual(strength(parseProfile(QUICK), { video: false, photo: false }), { percent: 25, next: "work" });
  assert.deepEqual(strength(parseProfile(FULL), { video: false, photo: false }), { percent: 40, next: "work" });
  const skilled = { ...parseProfile(QUICK), skills: ["espresso" as const] };
  assert.deepEqual(strength(skilled, { video: false, photo: false }), { percent: 45, next: "details" });
});

test("короткая анкета сохраняется, читается обратно и дополняется до полной", async () => {
  const s = await server();
  const created = await s.call("PUT", "/me/profile", { headers: auth, body: { profile: QUICK, consent: CONSENT } });
  assert.equal(created.status, 201);
  assert.deepEqual(
    [created.json.profile.experience, created.json.profile.employment, created.json.profile.start],
    [null, [], null],
  );
  assert.equal(created.json.strength.next, "work");
  const read = await s.call("GET", "/me/profile", { headers: auth });
  assert.equal(read.json.profile.experience, null);
  const filled = await s.call("PUT", "/me/profile", { headers: auth, body: { profile: FULL } });
  assert.equal(filled.status, 200);
  assert.equal(filled.json.profile.experience, "1to3");
  assert.equal(filled.json.strength.next, "work");
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

test("опыт, навыки и отметки: видны работодателю, не стираются старым приложением, «ищу сейчас» гаснет через 30 дней", async () => {
  let clock = NOW;
  const s = await startServer({ now: () => clock }, { PROFILES_OPEN: "1" });
  started.push(s);
  const worked = {
    ...FULL,
    jobs: [{ place: "Coffee Boom", role: "Бариста", term: "1to3" }],
    skills: ["espresso", "latte_art", "cash"],
    med: "soon",
    trial: true,
    looking: true,
  };
  // Профиль создаётся и с новым текстом согласия
  const created = await s.call("PUT", "/me/profile", {
    headers: auth,
    body: { profile: worked, consent: { version: CONSENT_VERSION, adult: true, base: false } },
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.profile.looking_at, "2026-11-04T06:00:00.000Z");
  assert.deepEqual(created.json.profile.skills, ["espresso", "latte_art", "cash"]);

  const link = await s.call("POST", "/me/link", { headers: auth });
  const open = () => s.call("GET", `/${link.json.code}`, { ...profileHost, headers: { "user-agent": BROWSER } });
  let page = (await open()).text;
  for (const text of ["Ищет работу сейчас", "Выйдет на пробную смену", "Санкнижку оформит", "Опыт работы",
    "<b>Бариста</b><span>Coffee Boom · 1–3 года</span>", "Умеет", "Эспрессо-машина", "Латте-арт", "Касса"]) {
    assert.ok(page.includes(text), text);
  }

  // Старое приложение о новых полях не знает: правка из него их не стирает
  const old = await s.call("PUT", "/me/profile", { headers: auth, body: { profile: { ...FULL, about: "Люблю кофе" } } });
  assert.deepEqual(old.json.profile.jobs, worked.jobs);
  assert.deepEqual([old.json.profile.skills.length, old.json.profile.med, old.json.profile.trial], [3, "soon", true]);
  assert.equal(old.json.profile.looking_at, "2026-11-04T06:00:00.000Z");

  // Через 31 день отметка «ищу сейчас» гаснет сама; остальное на месте
  clock = NOW + 31 * 86_400_000;
  page = (await open()).text;
  assert.ok(!page.includes("Ищет работу сейчас"));
  assert.ok(page.includes("Выйдет на пробную смену"));

  // Человек снимает отметки сам
  const later = { authorization: `tma ${initDataFor(AIGERIM, clock / 1000 - 60)}` };
  const off = await s.call("PUT", "/me/profile", { headers: later, body: { profile: { ...worked, looking: false, trial: false, med: "no", skills: [] } } });
  assert.deepEqual([off.json.profile.looking_at, off.json.profile.trial, off.json.profile.med], [null, false, "no"]);
  page = (await open()).text;
  // Ответ «нет санкнижки» работодателю не показываем
  assert.ok(!page.includes("анкнижк") && !page.includes("Умеет"));
});

test("что сказать в кружке: фразы из анкеты самого человека, по порядку и на его языке", () => {
  const p = parseProfile({
    ...FULL,
    jobs: [{ place: "Coffee Boom", role: "Бариста", term: "1to3" }],
    skills: ["espresso", "latte_art", "cash", "iiko", "knows_city"],
    trial: true,
  });
  assert.deepEqual(videoScript(p, "ru"), [
    "Здравствуйте! Меня зовут Айдана.",
    "Ищу работу: бариста.",
    "Мой опыт: бариста в Coffee Boom, 1–3 года.",
    "Умею: эспрессо-машина, латте-арт, касса.",
    "Могу выйти на этой неделе.",
    "Удобный график: смены.",
    "Могу выйти на пробную смену.",
    "Спасибо, буду ждать ответа!",
  ]);
  // Короткая анкета: только то, что человек уже указал
  assert.deepEqual(videoScript(parseProfile(QUICK), "ru"), [
    "Здравствуйте! Меня зовут Айдана.", "Ищу работу: бариста.", "Спасибо, буду ждать ответа!",
  ]);
  assert.equal(videoScript(parseProfile({ ...QUICK, experience: "none" }), "kk")[2], "Тәжірибем әзірге жоқ, бірақ тез үйренемін.");
});

test("район по адресу дома: работодатель видит район, только если человек указал дом после предупреждения", async () => {
  const s = await server();
  const home = { lat: 43.233, lon: 76.957, source: "2gis" }; // пр. Достык, Медеуский район
  const consent = { version: CONSENT_VERSION, adult: true, base: false };
  // Старое приложение: дом указан, но о районе человека не предупреждали — район не показываем
  const old = await s.call("PUT", "/me/profile", { headers: auth, body: { profile: { ...FULL, home }, consent } });
  assert.equal(old.status, 201, old.text);
  assert.deepEqual([old.json.profile.district, old.json.profile.home_district], [null, false]);
  const link = await s.call("POST", "/me/link", { headers: auth });
  const page = async () => (await s.call("GET", `/${link.json.code}`, { ...profileHost, headers: { "user-agent": BROWSER } })).text;
  assert.ok(!(await page()).includes("Медеуский"));

  // Новое приложение: человек подтвердил дом, зная, что работодатель увидит район
  const now = await s.call("PUT", "/me/profile", { headers: auth, body: { profile: { ...FULL, home, home_district: true } } });
  assert.deepEqual([now.json.profile.district, now.json.profile.home_district], ["Медеуский район", true]);
  const text = await page();
  assert.ok(text.includes("Алматы, Медеуский район"));
  assert.ok(!text.includes("43.2") && !text.includes("76.9")); // точки на странице нет

  // Правка без поля home (экран «Опыт и навыки») район не сбрасывает; район, присланный приложением, ничего не значит
  const edit = await s.call("PUT", "/me/profile", { headers: auth, body: { profile: { ...FULL, district: "Выдуманный район", trial: true } } });
  assert.equal(edit.json.profile.district, "Медеуский район");
  // Убрал дом — района нет
  const none = await s.call("PUT", "/me/profile", { headers: auth, body: { profile: { ...FULL, home: null } } });
  assert.deepEqual([none.json.profile.district, none.json.profile.home], [null, null]);
});

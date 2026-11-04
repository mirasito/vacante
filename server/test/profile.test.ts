import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { normalizePhone, parseProfile, strength, type Profile } from "../src/profile.ts";
import { AIGERIM, BROWSER, count, initDataFor, startServer, TOKEN, type TestServer } from "./helpers.ts";

const ANKETA = {
  name: "Айгерим",
  city: "almaty",
  district: "Бостандыкский",
  roles: ["Бариста", "Официант"],
  experience: "1to3",
  employment: ["full", "shifts"],
  pay_from: 200000,
  pay_period: "month",
  start: "week",
  languages: ["kk", "ru"],
};
const CONSENT = { version: "2026-11-04", adult: true, base: false };

const auth = (user: Record<string, unknown> = AIGERIM) => ({ authorization: `tma ${initDataFor(user)}` });
const beta = (user: Record<string, unknown> = AIGERIM) => ({ ...auth(user), "x-vacante-beta": "1" });

let s: TestServer;
before(async () => {
  s = await startServer();
});
after(() => s.close());

async function createProfile(user: Record<string, unknown> = AIGERIM, profile: Record<string, unknown> = ANKETA) {
  const r = await s.call("PUT", "/me/profile", { headers: beta(user), body: { consent: CONSENT, profile, lang: "ru" } });
  assert.equal(r.status, 201, r.text);
  return r.json;
}

test("номера Казахстана приводятся к +7 7…", () => {
  assert.equal(normalizePhone("+7 (701) 234-56-78"), "+77012345678");
  assert.equal(normalizePhone("87012345678"), "+77012345678");
  assert.equal(normalizePhone("7012345678"), "+77012345678");
  assert.equal(normalizePhone("+7 916 123-45-67"), null); // Россия
  assert.equal(normalizePhone("12345"), null);
});

test("анкета проверяется и чистится", () => {
  const p = parseProfile({ ...ANKETA, name: "  Айгерим  ", roles: ["Бариста", "Бариста"], about: "  " });
  assert.equal(p.name, "Айгерим");
  assert.deepEqual(p.roles, ["Бариста"]);
  assert.equal(p.about, null);
  assert.equal(p.pay_period, "month");
  assert.throws(() => parseProfile({ ...ANKETA, roles: [] }), /хотя бы одну/);
  assert.throws(() => parseProfile({ ...ANKETA, roles: ["a", "b", "c", "d"] }), /Не больше 3/);
  assert.throws(() => parseProfile({ ...ANKETA, city: "moscow" }), /city/);
  assert.throws(() => parseProfile({ ...ANKETA, employment: ["full", "remote"] }), /employment/);
  assert.throws(() => parseProfile({ ...ANKETA, phone: "123" }), /Телефон/);
  assert.throws(() => parseProfile({ ...ANKETA, about: "x".repeat(301) }), /300/);
  assert.throws(() => parseProfile({ ...ANKETA, pay_from: -5 }), /Зарплата/);
});

test("сила профиля: анкета 50, кружок 30, телефон 10, о себе и документы по 5", () => {
  const p = parseProfile(ANKETA) as Profile;
  assert.deepEqual(strength(p, false), { percent: 50, next: "video" });
  assert.deepEqual(strength({ ...p, phone: "+77012345678" }, true), { percent: 90, next: "about" });
  assert.deepEqual(strength({ ...p, phone: "+77012345678", about: "Люблю кофе", driver: true }, true), {
    percent: 100,
    next: null,
  });
});

test("профиль без согласия, без 18 лет или до открытия профилей не создаётся", async () => {
  const user = { id: 7100, first_name: "Тест" };
  const closed = await s.call("PUT", "/me/profile", { headers: auth(user), body: { consent: CONSENT, profile: ANKETA } });
  assert.equal(closed.status, 403);
  const noConsent = await s.call("PUT", "/me/profile", { headers: beta(user), body: { profile: ANKETA } });
  assert.equal(noConsent.status, 400);
  const old = await s.call("PUT", "/me/profile", {
    headers: beta(user),
    body: { consent: { ...CONSENT, version: "2020-01-01" }, profile: ANKETA },
  });
  assert.equal(old.status, 400);
  const young = await s.call("PUT", "/me/profile", {
    headers: beta(user),
    body: { consent: { ...CONSENT, adult: false }, profile: ANKETA },
  });
  assert.match(young.json.error, /18/);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM seekers WHERE id = ?", 7100), 0);
  assert.equal((await s.call("GET", "/me/profile", { headers: auth(user) })).status, 404);
});

test("тестировщик создаёт профиль, потом правит его", async () => {
  const created = await createProfile();
  assert.equal(created.profile.name, "Айгерим");
  assert.deepEqual(created.strength, { percent: 50, next: "video" });
  assert.equal(created.seeker.base, false);
  assert.equal(created.link, null);
  const consent = s.db.prepare("SELECT consent_version, consent_at FROM seekers WHERE id = ?").get(AIGERIM.id) as Record<string, string>;
  assert.equal(consent.consent_version, "2026-11-04");
  assert.equal(consent.consent_at, "2026-11-04T06:00:00Z");

  // Правка уже без согласия и без пометки тестировщика
  const edited = await s.call("PUT", "/me/profile", {
    headers: auth(),
    body: { profile: { ...ANKETA, about: "Люблю кофе", med_book: true, phone: "8 701 234 56 78" } },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.profile.phone, "+77012345678");
  assert.equal(edited.json.strength.percent, 70);

  const me = await s.call("GET", "/me", { headers: auth() });
  assert.equal(me.json.profile, true);

  const base = await s.call("PATCH", "/me", { headers: auth(), body: { base: true, write_access: true } });
  assert.equal(base.json.seeker.base, true);
  assert.equal(base.json.seeker.write_access, true);
});

test("страница профиля по общей ссылке: просмотры, телефон, превью без данных", async () => {
  const link = await s.call("POST", "/me/link", { headers: auth() });
  assert.equal(link.status, 201);
  const { code, url } = link.json;
  assert.match(code, /^[a-z2-9]{8}$/);
  assert.equal(url, `https://p.vacante.kz/${code}`);

  // Превью ссылки в WhatsApp: ни имени, ни данных, просмотр не считается
  const preview = await s.call("GET", `/${code}`, { host: "p.vacante.kz", headers: { "user-agent": "WhatsApp/2.24.1 A" } });
  assert.equal(preview.status, 200);
  assert.doesNotMatch(preview.text, /Айгерим/);
  assert.match(preview.text, /Профиль кандидата в Vacante/);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM views"), 0);

  const page = await s.call("GET", `/${code}`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER } });
  assert.equal(page.status, 200);
  assert.match(page.text, /Айгерим/);
  assert.match(page.text, /Бариста/);
  assert.match(page.text, /от 200 000 ₸ в месяц/);
  assert.match(page.text, /Показать телефон/);
  assert.doesNotMatch(page.text, /701 234 56 78/);
  assert.match(String(page.headers["x-robots-tag"]), /noindex/);
  assert.match(String(page.headers["content-security-policy"]), /default-src 'none'/);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM views"), 1);

  // Обновление страницы с тем же браузером не считается новым просмотром
  const cookie = (page.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]).join("; ");
  await s.call("GET", `/${code}`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER, cookie } });
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM views"), 1);

  const phone = await s.call("GET", `/${code}?phone=1`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER, cookie } });
  assert.match(phone.text, /\+7 701 234 56 78/);
  assert.match(phone.text, /wa\.me\/77012345678/);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM views WHERE phone_shown = 1"), 1);

  const kk = await s.call("GET", `/${code}?lang=kk`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER, cookie } });
  assert.match(kk.text, /Үміткер профилі/);

  const views = await s.call("GET", "/me/views", { headers: auth() });
  assert.equal(views.json.views.length, 2);
  assert.equal(views.json.views[0].phone_shown, true);

  // Новая ссылка выключает прежнюю, «Выключить» выключает и её
  const fresh = await s.call("POST", "/me/link", { headers: auth() });
  assert.equal((await s.call("GET", `/${code}`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER } })).status, 404);
  assert.equal(
    (await s.call("GET", `/${fresh.json.code}`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER } })).status,
    200,
  );
  await s.call("DELETE", "/me/link", { headers: auth() });
  const off = await s.call("GET", `/${fresh.json.code}`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER } });
  assert.equal(off.status, 404);
  assert.match(off.text, /Ссылка больше не работает/);
});

test("данные из анкеты не превращаются в разметку", async () => {
  const user = { id: 7200, first_name: "X" };
  await createProfile(user, { ...ANKETA, name: '<script>alert(1)</script>', about: '"><img src=x onerror=alert(1)>' });
  const { code } = (await s.call("POST", "/me/link", { headers: auth(user) })).json;
  const page = await s.call("GET", `/${code}`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER } });
  assert.doesNotMatch(page.text, /<script>alert/);
  assert.doesNotMatch(page.text, /<img src=x/);
  assert.match(page.text, /&lt;script&gt;/);
});

test("перебор кодов упирается в ограничение", async () => {
  let last = 0;
  for (let i = 0; i < 20; i++) {
    const r = await s.call("GET", `/abcdefg${"23456789"[i % 8]}`, {
      host: "p.vacante.kz",
      headers: { "user-agent": BROWSER, "x-forwarded-for": "203.0.113.7" },
    });
    last = r.status;
  }
  assert.equal(last, 429);
  // Другой адрес это не задевает
  const other = await s.call("GET", "/abcdefgh", { host: "p.vacante.kz", headers: { "user-agent": BROWSER, "x-forwarded-for": "203.0.113.8" } });
  assert.equal(other.status, 404);
});

test("номер из чата бота: только после просьбы приложения, только свой и только Казахстан", async () => {
  const key = (await import("../src/telegram.ts")).internalKey("123456:TEST-token_for-vacante-tests-0000");
  const contact = (fromId: number, userId: number, phone = "+77015556677") => ({
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: fromId, first_name: "A" },
      chat: { id: fromId, type: "private" },
      contact: { phone_number: phone, user_id: userId, first_name: "A" },
    },
  });
  const phoneOf = () => (s.db.prepare("SELECT phone FROM profiles WHERE seeker_id = ?").get(AIGERIM.id) as { phone: string | null }).phone;
  const denied = await s.call("POST", "/internal/telegram", { body: contact(AIGERIM.id, AIGERIM.id) });
  assert.equal(denied.status, 403);
  const headers = { authorization: `Bearer ${key}` };
  const relay = async (body: unknown) => (await s.call("POST", "/internal/telegram", { headers, body })).json.handled;
  const before = phoneOf();

  // Приложение номер не просило: это, например, ответ в отклике, его ведёт бот
  s.sent.length = 0;
  assert.equal(await relay(contact(AIGERIM.id, AIGERIM.id)), false);
  assert.equal(s.sent.length, 0);
  assert.equal(phoneOf(), before);

  assert.equal((await s.call("POST", "/me/phone/ask", { headers: auth() })).status, 200);
  // Чужой контакт и номер не из Казахстана не сохраняем, но отвечаем, почему
  assert.equal(await relay(contact(AIGERIM.id, 999, "+77010000000")), true);
  assert.match(String(s.sent[0]?.body.text), /свой номер/);
  assert.equal(await relay(contact(AIGERIM.id, AIGERIM.id, "+79161234567")), true);
  assert.match(String(s.sent[1]?.body.text), /номера Казахстана/);
  assert.equal(phoneOf(), before);

  assert.equal(await relay(contact(AIGERIM.id, AIGERIM.id)), true);
  assert.equal(phoneOf(), "+77015556677");
  assert.match(String(s.sent[2]?.body.text), /Номер добавлен/);
  // Отметка снята: следующий контакт снова для бота
  assert.equal(await relay(contact(AIGERIM.id, AIGERIM.id, "+77019998877")), false);
  assert.equal(phoneOf(), "+77015556677");

  // Человек закрыл окно, не поделившись: просьба снята
  await s.call("POST", "/me/phone/ask", { headers: auth() });
  assert.equal((await s.call("DELETE", "/me/phone/ask", { headers: auth() })).status, 200);
  assert.equal(await relay(contact(AIGERIM.id, AIGERIM.id, "+77019998877")), false);

  // Просьба действует 10 минут
  await s.call("POST", "/me/phone/ask", { headers: auth() });
  s.db.prepare("UPDATE seekers SET phone_asked_at = ? WHERE id = ?").run("2026-11-04T05:49:00Z", AIGERIM.id);
  assert.equal(await relay(contact(AIGERIM.id, AIGERIM.id, "+77019998877")), false);
  assert.equal(phoneOf(), "+77015556677");

  // Без профиля просить нечего, и в базе никто не появляется
  assert.equal((await s.call("POST", "/me/phone/ask", { headers: auth({ id: 4242, first_name: "Б" }) })).status, 404);
  assert.equal(await relay(contact(4242, 4242)), false);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM seekers WHERE id = 4242"), 0);
});

test("номер сохранён, даже если Telegram не принял ответ бота", async () => {
  const { Bot, internalKey } = await import("../src/telegram.ts");
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const other = await startServer({ bot: new Bot(TOKEN, down) });
  try {
    const user = { id: 7400, first_name: "Ерлан" };
    const put = await other.call("PUT", "/me/profile", { headers: beta(user), body: { consent: CONSENT, profile: ANKETA, lang: "ru" } });
    assert.equal(put.status, 201, put.text);
    await other.call("POST", "/me/phone/ask", { headers: auth(user) });
    const r = await other.call("POST", "/internal/telegram", {
      headers: { authorization: `Bearer ${internalKey(TOKEN)}` },
      body: { message: { message_id: 1, from: user, chat: { id: 7400, type: "private" }, contact: { phone_number: "87015556677", user_id: 7400 } } },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.handled, true); // иначе бот отдал бы тот же контакт в отклик
    assert.equal((other.db.prepare("SELECT phone FROM profiles WHERE seeker_id = 7400").get() as { phone: string }).phone, "+77015556677");
  } finally {
    await other.close();
  }
});

test("«Удалить профиль» стирает всё, и ссылка перестаёт открываться", async () => {
  const user = { id: 7300, first_name: "Дана" };
  await createProfile(user);
  const { code } = (await s.call("POST", "/me/link", { headers: auth(user) })).json;
  await s.call("GET", `/${code}`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER } });
  const r = await s.call("DELETE", "/me", { headers: auth(user) });
  assert.deepEqual(r.json, { deleted: true });
  for (const table of ["seekers WHERE id", "profiles WHERE seeker_id", "links WHERE seeker_id", "views WHERE seeker_id"]) {
    assert.equal(count(s, `SELECT COUNT(*) AS n FROM ${table} = ?`, 7300), 0, table);
  }
  assert.equal((await s.call("GET", `/${code}`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER } })).status, 404);
  assert.equal((await s.call("GET", "/me/profile", { headers: auth(user) })).status, 404);
});

test("когда профили открыты для всех, пометка тестировщика не нужна", async () => {
  const open = await startServer({}, { PROFILES_OPEN: "1" });
  try {
    const me = await open.call("GET", "/me", { headers: auth() });
    assert.equal(me.json.open, true);
    const r = await open.call("PUT", "/me/profile", { headers: auth(), body: { consent: CONSENT, profile: ANKETA } });
    assert.equal(r.status, 201);
  } finally {
    await open.close();
  }
});

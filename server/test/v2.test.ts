import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { reliability, venueReviews } from "../src/v2.ts";
import { AIGERIM, BROWSER, count, initDataFor, NOW, startServer, type TestServer } from "./helpers.ts";

const ANKETA = {
  name: "Айгерим",
  city: "almaty",
  district: null,
  roles: ["Бариста"],
  experience: "1to3",
  employment: ["shifts"],
  pay_from: null,
  pay_period: null,
  start: "week",
  languages: ["ru"],
};
const CONSENT = { version: "2026-11-04.2", adult: true, base: false };
const vacancy = (n: number, employer = "Кафе «Зерно»") => ({
  id: `almatyrabota1-${n}`,
  title: "Бариста",
  employer,
  city: "almaty",
  address: "ул. Сыганак, 2",
  url: `https://vacante.kz/v/almatyrabota1-${n}/`,
});
const OTHER = { id: 7002, first_name: "Ерлан", language_code: "kk" };
const auth = (user: Record<string, unknown> = AIGERIM) => ({ authorization: `tma ${initDataFor(user)}` });
const page = { host: "p.vacante.kz", "user-agent": BROWSER };
const form = (fields: Record<string, string>) => ({
  ...page,
  body: new URLSearchParams(fields).toString(),
  headers: { "user-agent": BROWSER, "content-type": "application/x-www-form-urlencoded" },
  host: "p.vacante.kz",
});
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

let s: TestServer;

before(async () => {
  s = await startServer({}, { BOT_URL: "https://bot.test" });
  for (const user of [AIGERIM, OTHER]) {
    const r = await s.call("PUT", "/me/profile", {
      headers: { ...auth(user), "x-vacante-beta": "1" },
      body: { profile: { ...ANKETA, name: user.first_name }, consent: CONSENT },
    });
    assert.equal(r.status, 201);
  }
});
after(() => s.close());

async function apply(n: number, employer?: string, user = AIGERIM) {
  const r = await s.call("POST", "/me/applications", { headers: auth(user), body: { vacancy: vacancy(n, employer) } });
  assert.ok(r.status === 201 || r.status === 200, r.text);
  return r.json.application as { id: number; link: { code: string } };
}

test("удобное время: соискатель предлагает, работодатель приглашает кнопкой", async () => {
  const app = await apply(1);
  const slots = [iso(NOW + 26 * H), iso(NOW + 50 * H)];
  const put = await s.call("PUT", `/me/applications/${app.id}/slots`, { headers: auth(), body: { slots: [...slots, slots[0]] } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.application.slots, slots);

  const bad = await s.call("PUT", `/me/applications/${app.id}/slots`, { headers: auth(), body: { slots: [iso(NOW - 5 * H)] } });
  assert.equal(bad.status, 400);

  const html = (await s.call("GET", `/${app.link.code}`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER } })).text;
  assert.match(html, /Кандидату удобно/);
  assert.match(html, new RegExp(`name="slot" value="${slots[1]}"`));

  const sent = s.sent.length;
  const r = await s.call("POST", `/${app.link.code}/answer`, form({ slot: slots[1]! }));
  assert.equal(r.status, 303);
  await s.idle();
  const view = (await s.call("GET", `/me/applications/${app.id}`, { headers: auth() })).json;
  assert.equal(view.stage, "interview");
  assert.equal(view.interview_at, slots[1]);
  assert.ok(s.sent.slice(sent).some((m) => String(m.body.text).includes("приглашают")));
});

test("«Не смогу прийти»: собеседование снимается, работодатель видит сообщение", async () => {
  const app = await apply(2);
  await s.call("PATCH", `/me/applications/${app.id}`, { headers: auth(), body: { interview_at: iso(NOW + 30 * H) } });
  const r = await s.call("POST", `/me/applications/${app.id}/cancel`, { headers: auth(), body: { text: "Заболела, можно в пятницу?" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.application.interview_at, null);
  assert.equal(r.json.application.stage, "invited");
  assert.ok(r.json.application.cancelled_at);
  const html = (await s.call("GET", `/${app.link.code}`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER } })).text;
  assert.match(html, /Заболела, можно в пятницу\?/);
  assert.match(html, /не сможет прийти/);
});

test("переписка: работодатель пишет со страницы, соискатель получает в бот и отвечает", async () => {
  const app = await apply(3);
  const sent = s.sent.length;
  const r = await s.call("POST", `/${app.link.code}/message`, form({ text: "Здравствуйте! Приходите завтра в 11:00" }));
  assert.equal(r.status, 303);
  await s.idle();
  const msg = s.sent.slice(sent).find((m) => String(m.body.text).startsWith("💬"));
  assert.ok(msg);
  assert.match(JSON.stringify(msg.body.reply_markup), /tab=chats&chat=/);

  const chats = (await s.call("GET", "/me/chats", { headers: auth() })).json;
  const chat = chats.chats.find((c: any) => c.application.id === app.id);
  assert.equal(chat.application.unread, 1);
  assert.equal(chat.last.by, "employer");

  const list = await s.call("GET", `/me/applications/${app.id}/messages`, { headers: auth() });
  assert.equal(list.json.messages.length, 1);
  assert.equal(list.json.application.unread, 0);

  const reply = await s.call("POST", `/me/applications/${app.id}/messages`, { headers: auth(), body: { text: "Спасибо, приду" } });
  assert.equal(reply.status, 201);
  const html = (await s.call("GET", `/${app.link.code}`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER } })).text;
  assert.match(html, /Спасибо, приду/);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM messages WHERE application_id = ? AND read_at IS NULL", app.id), 0);

  // Чужой отклик не открыть
  const other = await s.call("GET", `/me/applications/${app.id}/messages`, { headers: auth(OTHER) });
  assert.equal(other.status, 404);
});

test("пришёл / не пришёл и уровень надёжности", async () => {
  const id = (await apply(10)).id;
  const before = await s.call("PUT", `/me/applications/${id}/attended`, { headers: auth(), body: { attended: "yes" } });
  assert.equal(before.status, 409, "до собеседования отмечать нельзя");

  const ids = [id];
  for (let n = 11; n < 14; n++) ids.push((await apply(n)).id);
  for (const [i, x] of ids.entries()) {
    await s.call("PATCH", `/me/applications/${x}`, { headers: auth(), body: { interview_at: iso(NOW - (i + 2) * 24 * H) } });
  }
  const one = await s.call("PUT", `/me/applications/${ids[0]}/attended`, { headers: auth(), body: { attended: "yes" } });
  assert.equal(one.status, 200);
  assert.equal(one.json.reliability.level, "bronze");
  for (const x of ids.slice(1, 3)) await s.call("PUT", `/me/applications/${x}/attended`, { headers: auth(), body: { attended: "yes" } });
  assert.equal(reliability(s.db, AIGERIM.id).level, "silver");

  // Работодатель отметил неявку: его отметка главнее, серебро уходит
  const code = (await s.call("GET", `/me/applications/${ids[3]}`, { headers: auth() })).json.link.code;
  const html = (await s.call("GET", `/${code}`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER } })).text;
  assert.match(html, /Надёжность: Серебро · пришёл на 3 собеседования/);
  assert.match(html, /Кандидат пришёл на собеседование\?/);
  await s.call("POST", `/${code}/attended`, form({ attended: "no" }));
  const self = await s.call("PUT", `/me/applications/${ids[3]}/attended`, { headers: auth(), body: { attended: "yes" } });
  assert.equal(self.status, 200);
  const rel = (await s.call("GET", "/me/reliability", { headers: auth() })).json;
  assert.equal(rel.missed, 1);
  assert.equal(rel.level, "bronze");
});

test("отзывы: после собеседования, наружу только сводка от трёх отзывов", async () => {
  const early = await apply(20, "Ресторан «Дастархан»");
  const no = await s.call("PUT", `/me/applications/${early.id}/review`, { headers: auth(), body: { stars: 5 } });
  assert.equal(no.status, 409);
  await s.call("PATCH", `/me/applications/${early.id}`, { headers: auth(), body: { interview_at: iso(NOW - 2 * H) } });
  const ok = await s.call("PUT", `/me/applications/${early.id}/review`, {
    headers: auth(),
    body: { stars: 4, tags: ["polite", "hack"], text: "Всё честно" },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.application.review, 4);
  let pub = await s.call("GET", `/venues/reviews?name=${encodeURIComponent("  ресторан «дастархан» ")}`);
  assert.deepEqual(pub.json, { count: 1, stars: null, tags: [] });

  const other = await apply(21, "Ресторан «Дастархан»", OTHER);
  await s.call("PATCH", `/me/applications/${other.id}`, { headers: auth(OTHER), body: { interview_at: iso(NOW - 2 * H) } });
  await s.call("PUT", `/me/applications/${other.id}/review`, { headers: auth(OTHER), body: { stars: 5, tags: ["polite"] } });
  const third = await apply(22, "Ресторан «Дастархан»");
  await s.call("PATCH", `/me/applications/${third.id}`, { headers: auth(), body: { interview_at: iso(NOW - 3 * H) } });
  await s.call("PUT", `/me/applications/${third.id}/review`, { headers: auth(), body: { stars: 2, tags: ["late"] } });
  pub = await s.call("GET", `/venues/reviews?name=${encodeURIComponent("Ресторан «Дастархан»")}`);
  assert.equal(pub.json.count, 3);
  assert.equal(pub.json.stars, 3.7);
  assert.deepEqual(pub.json.tags[0], { tag: "polite", n: 2 });
  assert.ok(!JSON.stringify(pub.json).includes("Всё честно"), "тексты отзывов наружу не идут");
  assert.equal(venueReviews(s.db, "нет такого").count, 0);
});

test("приглашения: код, ссылка и счётчик", async () => {
  const me = (await s.call("GET", "/me/referral", { headers: auth() })).json;
  assert.match(me.code, /^[a-z0-9]{6}$/);
  assert.equal(me.url, `https://t.me/vacantekz_bot?startapp=ref_${me.code}`);
  assert.equal(me.invited, 0);
  const self = await s.call("POST", "/me/referral", { headers: auth(), body: { code: me.code } });
  assert.equal(self.json.ok, false);
  const ok = await s.call("POST", "/me/referral", { headers: auth(OTHER), body: { code: me.code } });
  assert.equal(ok.json.ok, true);
  const again = await s.call("POST", "/me/referral", { headers: auth(OTHER), body: { code: me.code } });
  assert.equal(again.json.ok, false);
  assert.equal((await s.call("GET", "/me/referral", { headers: auth() })).json.invited, 1);
});

test("выгрузка данных: короткая ссылка с JSON только своих данных", async () => {
  const r = await s.call("POST", "/me/export", { headers: auth() });
  assert.equal(r.status, 201);
  const path = new URL(r.json.url).pathname;
  const file = await s.call("GET", path);
  assert.equal(file.status, 200);
  assert.match(String(file.headers["content-disposition"]), /attachment/);
  assert.equal(file.json.account.id, AIGERIM.id);
  assert.ok(file.json.applications.length > 0);
  assert.ok(file.json.applications.some((a: any) => a.chat.length));
  assert.equal((await s.call("GET", "/export/nope")).status, 404);
});

test("жалоба уходит боту с внутренним ключом", async () => {
  const calls: { url: string; body: any }[] = [];
  const t = await startServer(
    {
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response("{}");
      }) as typeof fetch,
    },
    { BOT_URL: "https://bot.test" },
  );
  try {
    const r = await t.call("POST", "/me/report", {
      headers: auth(),
      body: { vacancy_id: "x-1", title: "Бариста", reason: "prepay", url: "https://evil.example/" },
    });
    assert.equal(r.status, 202);
    await t.idle();
    assert.equal(calls[0]?.url, "https://bot.test/internal/report");
    assert.equal(calls[0]?.body.reason, "prepay");
    assert.equal(calls[0]?.body.url, "");
    assert.equal(calls[0]?.body.from, AIGERIM.id);
  } finally {
    await t.close();
  }
});

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { funnel } from "../src/funnel.ts";
import { AIGERIM, BROWSER, initDataFor, NOW, startServer, type TestServer } from "./helpers.ts";

const KEY = "ab".repeat(32);
const admin = { authorization: `Bearer ${KEY}` };
const OTHER = { id: 7002, first_name: "Ерлан", language_code: "kk" };
const HOUR = 3_600_000;
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
const vacancy = (id: string) => ({
  id,
  title: "Бариста",
  employer: "Кафе «Зерно»",
  city: "almaty",
  url: `https://vacante.kz/v/${id}/`,
  source_url: "https://t.me/almatyrabota1/21258",
  contact: ["whatsapp"],
});
const profileHost = { host: "p.vacante.kz" };

// Упавший тест не доходит до close(): закрываем всё в конце, иначе прогон не завершится
const started: TestServer[] = [];
after(async () => {
  for (const s of started) await s.close().catch(() => undefined);
});

/** Сервер с часами, которые тест переводит сам; вход подписан тем же временем. */
async function server() {
  let clock = NOW;
  const s = await startServer({ now: () => clock }, { CRM_KEY: KEY, PROFILES_OPEN: "1" });
  started.push(s);
  const auth = (user: Record<string, unknown> = AIGERIM) => ({ authorization: `tma ${initDataFor(user, clock / 1000 - 60)}` });
  return {
    s,
    auth,
    tick: (ms: number) => void (clock += ms),
    event: (body: unknown, user?: Record<string, unknown>) => s.call("POST", "/me/events", { headers: auth(user), body }),
    profile: (extra: Record<string, unknown> = {}, user?: Record<string, unknown>) =>
      s.call("PUT", "/me/profile", { headers: auth(user), body: { profile: ANKETA, consent: CONSENT, ...extra } }),
    counts: () => s.db.prepare("SELECT day, source, step, n FROM funnel_counts ORDER BY source, step").all().map((r) => ({ ...r })),
    source: (id = AIGERIM.id) => (s.db.prepare("SELECT source FROM seekers WHERE id = ?").get(id) as { source: string | null } | undefined)?.source,
  };
}

test("открытие до согласия считается обезличенно: о человеке ничего не записано", async () => {
  const t = await server();
  const r = await t.event({ step: "open", source: "tg" });
  assert.equal(r.status, 204);
  assert.deepEqual(t.counts(), [{ day: "2026-11-04", source: "tg", step: "open", n: 1 }]);
  assert.equal(t.s.db.prepare("SELECT COUNT(*) AS n FROM seekers").get()!.n, 0);
  await t.s.close();
});

test("два открытия за день от одного человека — одно, от двух людей — два, на другой день снова считается", async () => {
  const t = await server();
  await t.event({ step: "open", source: "tg" });
  await t.event({ step: "open", source: "tg" });
  await t.event({ step: "open", source: "tg" }, OTHER);
  assert.equal(t.counts()[0]!.n, 2);
  t.tick(24 * HOUR);
  await t.event({ step: "open", source: "tg" });
  assert.deepEqual(
    t.counts().map((c) => [c.day, c.n]),
    [["2026-11-04", 2], ["2026-11-05", 1]],
  );
  await t.s.close();
});

test("метка не по формату считается без источника, неизвестный шаг — ошибка, без входа — 401", async () => {
  const t = await server();
  await t.event({ step: "open", source: "TG<script>" });
  assert.deepEqual(t.counts(), [{ day: "2026-11-04", source: "", step: "open", n: 1 }]);
  assert.equal((await t.event({ step: "hack" })).status, 400);
  assert.equal((await t.s.call("POST", "/me/events", { body: { step: "open" } })).status, 401);
  await t.s.close();
});

test("источник соискателя пишется вместе с первой анкетой и больше не меняется", async () => {
  const t = await server();
  assert.equal((await t.profile({ source: "tg" })).status, 201);
  assert.equal(t.source(), "tg");
  t.tick(2 * HOUR);
  await t.event({ step: "open", source: "ad12" });
  await t.profile({ source: "ad12" });
  assert.equal(t.source(), "tg");
  await t.s.close();
});

test("соискателю без метки её привязывает следующее событие; метка не по формату не привязывается", async () => {
  const t = await server();
  await t.profile({ source: "TG<script>" });
  assert.equal(t.source(), null);
  await t.event({ source: "ad12" });
  assert.equal(t.source(), "ad12");
  assert.deepEqual(t.counts(), []); // событие без шага ничего не считает
  await t.s.close();
});

test("отклик запоминает, ушёл ли он со ссылкой на профиль", async () => {
  const t = await server();
  await t.profile();
  const withLink = (id: number) => (t.s.db.prepare("SELECT with_link FROM applications WHERE id = ?").get(id) as { with_link: number }).with_link;
  const a = (await t.s.call("POST", "/me/applications", { headers: t.auth(), body: { vacancy: vacancy("a-1") } })).json.application.id;
  const b = (await t.s.call("POST", "/me/applications", { headers: t.auth(), body: { vacancy: vacancy("a-2") } })).json.application.id;
  assert.equal((await t.s.call("PATCH", `/me/applications/${a}`, { headers: t.auth(), body: { stage: "sent", link: true } })).status, 200);
  assert.equal((await t.s.call("PATCH", `/me/applications/${b}`, { headers: t.auth(), body: { stage: "sent" } })).status, 200);
  assert.equal(withLink(a), 1);
  assert.equal(withLink(b), 0);
  assert.equal((await t.s.call("PATCH", `/me/applications/${b}`, { headers: t.auth(), body: { link: "yes" } })).status, 400);
  await t.s.close();
});

test("удаление соискателя не оставляет о нём ничего, кроме обезличенных чисел", async () => {
  const t = await server();
  await t.event({ step: "open", source: "tg" });
  await t.profile({ source: "tg" });
  assert.equal((await t.s.call("DELETE", "/me", { headers: t.auth() })).status, 200);
  assert.equal(t.s.db.prepare("SELECT COUNT(*) AS n FROM seekers").get()!.n, 0);
  assert.deepEqual(t.counts(), [{ day: "2026-11-04", source: "tg", step: "open", n: 1 }]);
  await t.s.close();
});

test("воронка: шаги по источникам, «дошёл» один раз на отклик, превью не считается", async () => {
  const t = await server();
  // Айгерим пришла из канала: открыла, начала анкету, создала профиль, два отклика — один со ссылкой
  await t.event({ step: "open", source: "tg" });
  await t.event({ step: "profile_start", source: "tg" });
  await t.profile({ source: "tg" });
  const apply = async (id: string, link: boolean) => {
    const app = (await t.s.call("POST", "/me/applications", { headers: t.auth(), body: { vacancy: vacancy(id) } })).json.application;
    await t.s.call("PATCH", `/me/applications/${app.id}`, { headers: t.auth(), body: { stage: "sent", method: "whatsapp", link } });
    return app.link.code as string;
  };
  const code = await apply("a-1", true);
  await apply("a-2", false);
  // Ерлан пришёл с рекламы и только открыл приложение
  await t.event({ step: "open", source: "ad12" }, OTHER);

  // Превью мессенджера, потом работодатель открывает ссылку трижды и приглашает
  await t.s.call("GET", `/${code}`, { ...profileHost, headers: { "user-agent": "TelegramBot (like TwitterBot)" } });
  for (let i = 0; i < 3; i++) await t.s.call("GET", `/${code}`, { ...profileHost, headers: { "user-agent": BROWSER } });
  const answer = await t.s.call("POST", `/${code}/answer`, {
    ...profileHost,
    headers: { "user-agent": BROWSER, "content-type": "application/x-www-form-urlencoded" },
    body: "answer=invite&at=2026-11-05T15%3A00",
  });
  assert.equal(answer.status, 303);

  const r = await t.s.call("GET", "/admin/funnel?days=7", { headers: admin });
  assert.equal(r.status, 200);
  const row = (source: string) => r.json.rows.find((x: { source: string }) => x.source === source);
  assert.deepEqual(row("tg"), {
    day: "2026-11-04", source: "tg", opened: 1, profile_started: 1, profile_done: 1, sent: 2, sent_with_link: 1, reached: 1, answered: 1,
  });
  assert.deepEqual(row("ad12"), {
    day: "2026-11-04", source: "ad12", opened: 1, profile_started: 0, profile_done: 0, sent: 0, sent_with_link: 0, reached: 0, answered: 0,
  });
  assert.equal(r.json.total.opened, 2);
  assert.equal(r.json.total.sent, 2);
  assert.deepEqual(r.json.sources.map((x: { source: string }) => x.source), ["ad12", "tg"]);
  await t.s.close();
});

test("воронка: день считается по времени Казахстана, соискатель без метки идёт строкой «—»", async () => {
  const t = await server();
  t.tick(13 * HOUR + 30 * 60_000); // 2026-11-04 19:30 UTC = 2026-11-05 00:30 в Казахстане
  await t.event({ step: "open" });
  await t.profile();
  assert.deepEqual(
    funnel(t.s.db, "2026-11-05", "2026-11-05").map((x) => [x.day, x.source, x.opened, x.profile_done]),
    [["2026-11-05", "—", 1, 1]],
  );
  assert.deepEqual(funnel(t.s.db, "2026-11-04", "2026-11-04"), []);
  await t.s.close();
});

test("воронка только для админки: без пароля 403, без настроенного секрета 503", async () => {
  const t = await server();
  assert.equal((await t.s.call("GET", "/admin/funnel")).status, 403);
  assert.equal((await t.s.call("GET", "/admin/funnel", { headers: { authorization: "Bearer nope" } })).status, 403);
  await t.s.close();
  const bare = await startServer();
  assert.equal((await bare.call("GET", "/admin/funnel", { headers: admin })).status, 503);
  await bare.close();
});

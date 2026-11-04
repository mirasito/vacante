import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { streakOf } from "../src/progress.ts";
import { runReminders, type BotDeps } from "../src/reminder-bot.ts";
import { putVideo } from "../src/seekers.ts";
import { internalKey } from "../src/telegram.ts";
import { AIGERIM, BROWSER, count, fakeBot, initDataFor, NOW, startServer, TOKEN, type TestServer } from "./helpers.ts";

// NOW — среда 4 ноября, 11:00 в Алматы. Недели с понедельника: 2, 9, 16, 23, 30 ноября
const local = (day: string, time: string) => Date.parse(`${day}T${time}:00+05:00`);
const utc = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, "Z");

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
const vacancy = (n: number) => ({
  id: `almatyrabota1-${30000 + n}`,
  title: `Бариста ${n}`,
  employer: "Кафе «Зерно»",
  city: "almaty",
  url: `https://vacante.kz/v/almatyrabota1-${30000 + n}/`,
  source_url: `https://t.me/almatyrabota1/${30000 + n}`,
  contact: ["whatsapp"],
});

let clock = NOW;
let s: TestServer;
let deps: BotDeps;
afterEach(() => s?.close());

async function setup() {
  clock = NOW;
  s = await startServer({ now: () => clock });
  deps = { db: s.db, bot: fakeBot(s.sent), config: s.config, fetch, now: () => clock };
}

type User = { id: number; first_name: string; language_code?: string };
const auth = (user: User = AIGERIM) => ({ authorization: `tma ${initDataFor(user, clock / 1000 - 60)}` });
const api = async (method: string, path: string, body?: unknown, user: User = AIGERIM) => {
  const r = await s.call(method, path, { headers: auth(user), body });
  assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${r.text}`);
  return r.json;
};

async function createProfile(user: User = AIGERIM, lang = "ru") {
  const r = await s.call("PUT", "/me/profile", {
    headers: { ...auth(user), "x-vacante-beta": "1" },
    body: { consent: CONSENT, profile: { ...ANKETA, name: user.first_name }, lang },
  });
  assert.equal(r.status, 201, r.text);
}

type Goal = { goal: number | null; sent: number; streak: number; forgiven: boolean; last: { goal: number; sent: number } | null };
type Achievement = { kind: string; at: string; seen: boolean };
const summary = async (user: User = AIGERIM) =>
  (await api("GET", "/me/applications", undefined, user)).summary as { goal: Goal; achievements: Achievement[] };
const goal = async () => (await summary()).goal;

let next = 0;
/** Отправленный отклик. Закрытый («Нет ответа»), чтобы не было напоминаний: в цель он всё равно идёт. */
async function sent(close = true) {
  const { application } = await api("POST", "/me/applications", { vacancy: vacancy(++next) });
  await api("PATCH", `/me/applications/${application.id}`, { stage: "sent", method: "hh" });
  if (close) await api("PATCH", `/me/applications/${application.id}`, { stage: "no_answer" });
  return application as { id: number; link: { code: string } };
}

test("серия недель: идущая неделя не обрывает, один пропуск в месяц прощается", () => {
  const w = (sent: number, goal = 3) => ({ goal, sent });
  // Идущая неделя последняя: пока цель не выполнена, она не прибавляет и не обрывает
  assert.deepEqual(streakOf([w(3), w(3), w(1)]), { streak: 2, forgiven: false });
  assert.deepEqual(streakOf([w(3), w(3), w(3)]), { streak: 3, forgiven: false });
  // Прошлую неделю пропустили: прощается, и это видно
  assert.deepEqual(streakOf([w(3), w(3), w(0), w(0)]), { streak: 2, forgiven: true });
  // Два пропуска ближе месяца: серия только после последнего
  assert.deepEqual(streakOf([w(3), w(0), w(3), w(0), w(0)]), { streak: 1, forgiven: true });
  // Пропуски через 4 недели: оба прощены
  assert.deepEqual(streakOf([w(3), w(0), w(3), w(3), w(3), w(0), w(3)]), { streak: 5, forgiven: true });
  // Неделя без цели обрывает серию
  assert.deepEqual(streakOf([w(3), w(5, 0), w(3), w(3)]), { streak: 2, forgiven: false });
  // Прощать нечего, если до пропуска серии не было
  assert.deepEqual(streakOf([w(0), w(0)]), { streak: 0, forgiven: false });
  assert.deepEqual(streakOf([w(5, 10), w(4, 5)]), { streak: 0, forgiven: false });
});

test("цель недели: выбор, кольцо, серия, удалённый отклик не отнимает неделю", async () => {
  await setup();
  await createProfile();
  assert.deepEqual(await goal(), { goal: null, sent: 0, streak: 0, forgiven: false, last: null });

  for (const bad of [4, "5", 0, undefined]) {
    const r = await s.call("PUT", "/me/goal", { headers: auth(), body: { goal: bad } });
    assert.equal(r.status, 400, String(bad));
  }
  const set = await api("PUT", "/me/goal", { goal: 3 });
  assert.deepEqual(set.summary.goal, { goal: 3, sent: 0, streak: 0, forgiven: false, last: null });

  // Неделя 2 ноября: три отклика — цель выполнена, серия 1. «Нравится» не считается
  await api("POST", "/me/applications", { vacancy: vacancy(100) });
  const first = await sent();
  await sent();
  assert.deepEqual(await goal(), { goal: 3, sent: 2, streak: 0, forgiven: false, last: null });
  await sent();
  assert.deepEqual(await goal(), { goal: 3, sent: 3, streak: 1, forgiven: false, last: null });

  // Новая неделя: цель та же, кольцо с нуля, прошлая неделя в серии
  clock = local("2026-11-09", "10:00");
  assert.deepEqual(await goal(), { goal: 3, sent: 0, streak: 1, forgiven: false, last: { goal: 3, sent: 3 } });
  // Закончившаяся неделя записана: удалённый отклик её не отнимает
  const removed = await api("DELETE", `/me/applications/${first.id}`);
  assert.deepEqual(removed.summary.goal.last, { goal: 3, sent: 3 });
  assert.equal(removed.summary.goal.streak, 1);

  // Неделю 9 ноября пропустили: в среду 18-го серия сохранена, это первый пропуск за месяц
  clock = local("2026-11-18", "12:00");
  assert.deepEqual(await goal(), { goal: 3, sent: 0, streak: 1, forgiven: true, last: { goal: 3, sent: 0 } });
  await sent();
  await sent();
  await sent();
  assert.deepEqual(await goal(), { goal: 3, sent: 3, streak: 2, forgiven: true, last: { goal: 3, sent: 0 } });

  // Неделю 23-го снова пропустили: второй пропуск за месяц, серия считается с 16-го
  clock = local("2026-12-02", "12:00");
  assert.deepEqual(await goal(), { goal: 3, sent: 0, streak: 1, forgiven: true, last: { goal: 3, sent: 0 } });

  // Цель поменяли посреди недели: она уже на этой неделе. Выключили — серия обрывается, включили — вернулась
  assert.equal((await api("PUT", "/me/goal", { goal: 5 })).summary.goal.goal, 5);
  assert.deepEqual((await api("PUT", "/me/goal", { goal: null })).summary.goal, {
    goal: null,
    sent: 0,
    streak: 0,
    forgiven: false,
    last: { goal: 3, sent: 0 },
  });
  assert.equal((await api("PUT", "/me/goal", { goal: 3 })).summary.goal.streak, 1);
  // Неделя записывается один раз; у недели без строки цель прежней
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM goal_weeks WHERE seeker_id = ?", AIGERIM.id), 5);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM goal_weeks WHERE sent IS NULL"), 1);
});

test("цель с телефона ложится на новый профиль вместе с серией, но не поверх цели на сервере", async () => {
  await setup();
  await createProfile();
  // До профиля: цель 3 с 19 октября, по три отклика за две прошлые недели и один на этой
  const days = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-27", "2026-10-28", "2026-10-29", "2026-11-03"];
  const items = days.map((day, i) => ({
    vacancy: vacancy(200 + i),
    liked_at: utc(local(day, "09:00")),
    sent_at: utc(local(day, "10:00")),
    stage: "sent",
    method: "hh",
  }));
  assert.equal((await api("POST", "/me/applications/import", { items })).imported, 7);
  const history = [
    { week: "2026-10-19", goal: 3 },
    { week: "2026-10-28", goal: 5 }, // не понедельник
    { week: "2026-10-26", goal: 7 }, // такой цели нет
    { week: "2026-11-02", goal: 10 }, // идущая неделя: её цель приходит отдельно
    { week: "2027-01-04", goal: 3 }, // будущая
    "x",
  ];
  const bad = await s.call("POST", "/me/goal/import", { headers: auth(), body: { goal: 4, history } });
  assert.equal(bad.status, 400);
  const r = await api("POST", "/me/goal/import", { goal: 3, history });
  assert.deepEqual(r.summary.goal, { goal: 3, sent: 1, streak: 2, forgiven: false, last: { goal: 3, sent: 3 } });
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM goal_weeks WHERE seeker_id = ?", AIGERIM.id), 3);

  // На сервере цель уже есть: перенос с другого телефона её не трогает
  const again = await api("POST", "/me/goal/import", { goal: 10, history: [{ week: "2026-10-26", goal: 0 }] });
  assert.deepEqual(again.summary.goal, r.summary.goal);
  await api("PUT", "/me/goal", { goal: null });
  assert.equal((await api("POST", "/me/goal/import", { goal: 5, history: [] })).summary.goal.goal, null);
});

test("достижения: кружок, первый отклик, приглашение, собеседование, работа", async () => {
  await setup();
  await createProfile();
  assert.deepEqual((await summary()).achievements, []);
  const kinds = async () => (await summary()).achievements.map((a) => `${a.kind} ${a.at}${a.seen ? " seen" : ""}`);

  // Кружок: сервер скачал его из чата бота
  putVideo(s.db, AIGERIM.id, { file_id: "f", file_unique_id: "u", file: "f.mp4", poster: null, duration: 30, size: 100, recorded_at: utc(clock) });
  assert.deepEqual(await kinds(), [`video ${utc(NOW)}`]);

  // Первый отклик — когда отправлен, а не когда понравился
  const { application: a } = await api("POST", "/me/applications", { vacancy: vacancy(1) });
  clock += 60_000;
  await api("PATCH", `/me/applications/${a.id}`, { stage: "sent", method: "whatsapp" });
  assert.deepEqual(await kinds(), [`video ${utc(NOW)}`, `first_sent ${utc(NOW + 60_000)}`]);

  // Отменённое до времени собеседование не считается. Дата собеседования от самого человека — тоже приглашение
  clock += 60_000;
  const { application: b } = await api("POST", "/me/applications", { vacancy: vacancy(2) });
  await api("PATCH", `/me/applications/${b.id}`, { interview_at: utc(local("2026-11-05", "12:00")) });
  await api("PATCH", `/me/applications/${b.id}`, { stage: "rejected" });

  // Работодатель приглашает со страницы профиля на четверг 15:00
  clock += 60_000;
  const invite = await s.call("POST", `/${a.link.code}/answer`, {
    host: "p.vacante.kz",
    headers: { "user-agent": BROWSER, "content-type": "application/x-www-form-urlencoded" },
    body: "answer=invite&at=2026-11-05T15%3A00",
  });
  assert.equal(invite.status, 303);
  await s.idle();
  // Приглашение засчитано раньше, у отменённого отклика
  assert.equal((await summary()).achievements.find((x) => x.kind === "first_invite")?.at, utc(NOW + 120_000));
  assert.ok(!(await kinds()).some((k) => k.startsWith("first_interview")));

  // Четверг 16:00: собеседование прошло
  clock = local("2026-11-05", "16:00");
  assert.ok((await kinds()).includes(`first_interview ${utc(local("2026-11-05", "15:00"))}`));

  // Приложение поздравило: второй раз не показываем, а следующее достижение снова новое
  await api("POST", "/me/achievements/seen");
  assert.ok((await summary()).achievements.every((x) => x.seen));
  await api("PATCH", `/me/applications/${a.id}`, { stage: "offer" });
  await api("PATCH", `/me/applications/${a.id}`, { stage: "hired" });
  const all = (await summary()).achievements;
  assert.deepEqual(all.map((x) => x.kind), ["video", "first_sent", "first_invite", "first_interview", "hired"]);
  assert.deepEqual(all.filter((x) => !x.seen).map((x) => x.kind), ["hired"]);

  // Удалённый отклик достижения не забирает, удалённый профиль стирает всё
  await api("DELETE", `/me/applications/${a.id}`);
  assert.equal((await summary()).achievements.length, 5);
  await api("PUT", "/me/goal", { goal: 3 });
  await api("DELETE", "/me");
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM achievements"), 0);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM goal_weeks"), 0);
});

test("итог недели в боте говорит о цели без упрёков, /otkliki показывает кольцо", async () => {
  await setup();
  await createProfile();
  // Кружок есть: напоминание о нём не займёт место итога недели
  putVideo(s.db, AIGERIM.id, { file_id: "f", file_unique_id: "u", file: "f.mp4", poster: null, duration: 30, size: 100, recorded_at: utc(clock) });
  await api("PUT", "/me/goal", { goal: 3 });
  // Итог недели приходит, пока поиск идёт: одна вакансия «Нравится» без напоминаний
  await api("POST", "/me/applications", { vacancy: vacancy(999) });
  const weekText = async (when: number) => {
    clock = when;
    const before = s.sent.length;
    await runReminders(deps);
    const m = s.sent.slice(before).find((x) => x.method === "sendMessage" && /Итог прошлой недели/.test(String(x.body.text)));
    assert.ok(m, "нет итога недели");
    return String(m.body.text);
  };

  for (let i = 0; i < 3; i++) await sent();
  assert.match(await weekText(local("2026-11-09", "10:00")), /\n🎯 Цель выполнена: 3 из 3\.\nНовые вакансии уже в ленте\.$/);

  clock = local("2026-11-11", "12:00");
  for (let i = 0; i < 4; i++) await sent();
  assert.match(await weekText(local("2026-11-16", "10:00")), /🎯 Цель выполнена: 4 из 3\. Уже 2 недели подряд!/);

  // Не выполнили: только цель на новую неделю и что серия не прервалась
  clock = local("2026-11-18", "12:00");
  await sent();
  assert.match(
    await weekText(local("2026-11-23", "10:00")),
    /🎯 Цель на эту неделю: 3 отклика\. Серия не прервалась: один пропуск в месяц можно\./,
  );

  // /otkliki: кольцо этой недели и серия
  clock = local("2026-11-24", "12:00");
  await sent(false);
  const r = await s.call("POST", "/internal/telegram", {
    headers: { authorization: `Bearer ${internalKey(TOKEN)}` },
    body: { message: { message_id: 10, from: AIGERIM, chat: { id: AIGERIM.id, type: "private" }, text: "/otkliki" } },
  });
  assert.equal(r.json.handled, true);
  const reply = s.sent.filter((x) => x.method === "sendMessage").at(-1);
  assert.match(String(reply?.body.text), /^📋 Ваши отклики\n\n🎯 Цель недели: 1 из 3 · 🔥 2 недели подряд\n\n/);
});

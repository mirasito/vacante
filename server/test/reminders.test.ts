import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { runReminders, type BotDeps } from "../src/reminder-bot.ts";
import { putVideo } from "../src/seekers.ts";
import { Bot, internalKey } from "../src/telegram.ts";
import { AIGERIM, count, fakeBot, initDataFor, NOW, startServer, TOKEN, type Sent, type TestServer } from "./helpers.ts";

// Время в тестах: NOW — среда 4 ноября, 11:00 в Алматы (06:00 UTC). Казахстан живёт по UTC+5
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
const CONSENT = { version: "2026-11-04", adult: true, base: false };
const vacancy = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `almatyrabota1-${21258 + n}`,
  title: `Бариста ${n}`,
  employer: "Кафе «Зерно»",
  city: "almaty",
  address: "ул. Сыганак, 2",
  map: "https://2gis.kz/almaty/search/sygnak",
  url: `https://vacante.kz/v/almatyrabota1-${21258 + n}/`,
  source_url: "https://t.me/almatyrabota1/21258",
  contact: ["whatsapp", "phone"],
  ...extra,
});

/** Пост с номером, как его отдаёт t.me/…?embed=1. */
const POST_HTML =
  `<div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="almatyrabota1/21258" data-view="x">` +
  `<div class="tgme_widget_message_text js-message_text" dir="auto">Требуется бариста<br/>WhatsApp: 8 701 123 45 67</div>` +
  `<div class="tgme_widget_message_footer compact js-message_footer"></div></div>`;
const fakeFetch = (async (url: string | URL) =>
  new Response(String(url) === "https://t.me/almatyrabota1/21258?embed=1&mode=tme" ? POST_HTML : "<html></html>")) as typeof fetch;

let clock = NOW;
let s: TestServer;
let deps: BotDeps;
afterEach(() => s?.close());

async function setup(bot?: Bot) {
  clock = NOW;
  s = await startServer({ now: () => clock, fetch: fakeFetch });
  deps = { db: s.db, bot: bot ?? fakeBot(s.sent), config: s.config, fetch: fakeFetch, now: () => clock };
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

/** Отклик с нужной стадией и полями. */
async function application(n: number, patch: Record<string, unknown>, user: User = AIGERIM, extra: Record<string, unknown> = {}) {
  const { application } = await api("POST", "/me/applications", { vacancy: vacancy(n, extra) }, user);
  await api("PATCH", `/me/applications/${application.id}`, patch, user);
  return application.id as number;
}

type View = { id: number; kind: string; due_at: string; status: string; active: boolean; application: { id: number } | null };
const reminders = async (user: User = AIGERIM) => (await api("GET", "/me/reminders", undefined, user)) as {
  reminders: View[];
  due: number;
  settings: { off: string[]; bot: boolean };
};
const active = async (user: User = AIGERIM) =>
  (await reminders(user)).reminders.filter((r) => r.active).map((r) => `${r.kind} ${r.due_at}`);

/** Что ушло в бот: сообщения с напоминаниями. */
const messages = (from = 0) => s.sent.slice(from).filter((m) => m.method === "sendMessage");
const buttons = (m: Sent) =>
  ((m.body.reply_markup as { inline_keyboard?: { text: string; callback_data?: string; url?: string; web_app?: { url: string } }[][] })
    ?.inline_keyboard ?? []).flat();
const run = async (when: number) => {
  clock = when;
  const before = s.sent.length;
  await runReminders(deps);
  return messages(before);
};

const relay = (update: unknown) =>
  s.call("POST", "/internal/telegram", { headers: { authorization: `Bearer ${internalKey(TOKEN)}` }, body: update });
/** Нажать кнопку под сообщением бота. */
async function press(m: Sent, data: string, user: User = AIGERIM) {
  const before = s.sent.length;
  const r = await relay({
    callback_query: {
      id: `cq-${data}`,
      from: user,
      data,
      message: { message_id: 500, chat: { id: user.id, type: "private" }, text: String(m.body.text) },
    },
  });
  assert.equal(r.json.handled, true);
  await s.idle();
  return s.sent.slice(before);
}
const say = async (text: string, user: User = AIGERIM) => {
  const before = s.sent.length;
  const r = await relay({ message: { message_id: 10, from: user, chat: { id: user.id, type: "private" }, text } });
  return { handled: r.json.handled as boolean, sent: s.sent.slice(before) };
};
const callbackOf = (m: Sent, action: string) => {
  const b = buttons(m).find((x) => x.callback_data?.endsWith(`:${action}`));
  assert.ok(b, `нет кнопки ${action} в ${JSON.stringify(buttons(m))}`);
  return b.callback_data!;
};

test("напоминания по откликам и профилю: когда какие", async () => {
  await setup();
  await createProfile();
  await application(1, { stage: "sent", method: "whatsapp" });
  await application(2, { stage: "sent", method: "call" });
  assert.deepEqual(await active(), [
    `profile ${utc(local("2026-11-05", "11:00"))}`,
    `write_again ${utc(local("2026-11-06", "11:00"))}`,
    `status_check ${utc(local("2026-11-11", "11:00"))}`,
    `status_check ${utc(local("2026-11-11", "11:00"))}`,
  ]);
  // «Написать ещё раз» только для WhatsApp и Telegram: позвонить можно и без напоминания
  const { reminders: list, due } = await reminders();
  assert.equal(list.filter((r) => r.kind === "write_again").length, 1);
  assert.equal(due, 0);

  // Собеседование в четверг в 15:00: накануне в 19:00, за два часа и «Как прошло?» в пятницу утром
  const id = await application(3, { interview_at: utc(local("2026-11-05", "15:00")) });
  const interview = (await active()).filter((r) => /^(interview|how)/.test(r));
  assert.deepEqual(interview, [
    `interview_eve ${utc(local("2026-11-04", "19:00"))}`,
    `interview_soon ${utc(local("2026-11-05", "13:00"))}`,
    `how_was_it ${utc(local("2026-11-06", "10:00"))}`,
  ]);
  assert.equal((await reminders()).due, 1); // сегодня в 19:00

  // Перенесли на пятницу 8:00: прежние отменены, за два часа — не раньше 7:00
  await api("PATCH", `/me/applications/${id}`, { interview_at: utc(local("2026-11-06", "08:00")) });
  const moved = await reminders();
  assert.deepEqual(
    moved.reminders.filter((r) => r.active && r.application?.id === id).map((r) => `${r.kind} ${r.due_at}`),
    [
      `interview_eve ${utc(local("2026-11-05", "19:00"))}`,
      `interview_soon ${utc(local("2026-11-06", "07:00"))}`,
      `how_was_it ${utc(local("2026-11-07", "10:00"))}`,
    ],
  );
  // Отменённое системой в историю не попадает
  assert.equal(moved.reminders.filter((r) => r.application?.id === id).length, 3);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM reminders WHERE status = 'dismissed' AND closed_by = 'system'"), 3);

  // Предложили работу с выходом в понедельник: накануне вечером адрес и что взять
  await api("PATCH", `/me/applications/${id}`, { stage: "offer", start_at: "2026-11-09" });
  assert.ok((await active()).includes(`start_eve ${utc(local("2026-11-08", "19:00"))}`));
  assert.equal((await active()).filter((r) => r.startsWith("interview")).length, 0);
});

test("итог недели в понедельник, если на прошлой неделе были отклики", async () => {
  await setup();
  await createProfile();
  await application(1, { stage: "sent", method: "hh" });
  clock = local("2026-11-09", "08:00");
  assert.ok((await active()).includes(`week ${utc(local("2026-11-09", "10:00"))}`));
  const [week] = await run(local("2026-11-09", "10:00"));
  assert.ok(week);
  assert.match(String(week.body.text), /Итог прошлой недели: 1 отклик, 0 посмотрели, 0 приглашений/);
  assert.deepEqual(
    buttons(week).map((b) => b.text),
    ["📋 Мои отклики", "🃏 Листать вакансии", "🔕 Не присылать такие"],
  );
  assert.match(buttons(week)[0]!.web_app!.url, /\/app\/\?tab=applications&city=almaty$/);
  // Через неделю без откликов итога нет
  clock = local("2026-11-16", "09:00");
  assert.equal((await active()).filter((r) => r.startsWith("week")).length, 0);
});

test("в бот: с 9 до 21, не больше двух в день, за два часа до собеседования — с 7:00", async () => {
  await setup();
  await createProfile();
  await application(1, { stage: "sent", method: "whatsapp" });
  await application(2, { stage: "sent", method: "telegram" });
  await application(3, { stage: "interview", interview_at: utc(local("2026-11-06", "08:00")) });
  await api("POST", "/me/reminders", { text: "Позвонить в кафе", at: utc(local("2026-11-06", "14:00")) });

  // Четверг: кружок для профиля утром, собеседование вечером
  assert.deepEqual(await run(local("2026-11-05", "08:59")), []);
  assert.deepEqual((await run(local("2026-11-05", "11:00"))).map((m) => buttons(m)[0]?.text), ["🎥 Записать кружок"]);
  const [eve] = await run(local("2026-11-05", "19:00"));
  assert.ok(eve);
  assert.match(String(eve.body.text), /^📅 Завтра в 08:00 собеседование: «Бариста 3» \(Кафе «Зерно»\)\.\nАдрес: ул\. Сыганак, 2\.$/);
  assert.deepEqual(
    buttons(eve).map((b) => b.text),
    ["🗺 Адрес на карте", "⏰ Опаздываю", "🔁 Перенести", "🔕 Не присылать такие"],
  );
  assert.match(buttons(eve)[2]!.web_app!.url, /\/app\/\?tab=applications&app=\d+&city=almaty$/);

  // Пятница: за два часа до собеседования в 7:00, хотя окно с 9:00
  assert.deepEqual(await run(local("2026-11-06", "06:55")), []);
  const [soon] = await run(local("2026-11-06", "07:00"));
  assert.match(String(soon?.body.text), /^⏰ Сегодня в 08:00 собеседование/);

  // Две подсказки «Написать ещё раз» — в день только одна, второе место остаётся своему напоминанию
  const [again, ...rest] = await run(local("2026-11-06", "11:00"));
  assert.deepEqual(rest, []);
  assert.match(String(again?.body.text), /пока тихо: профиль не открывали/);
  const [mine] = await run(local("2026-11-06", "14:00"));
  assert.equal(mine?.body.text, "🔔 Позвонить в кафе");
  assert.deepEqual(await run(local("2026-11-06", "14:05")), []); // лимит

  // «Через час»: отложенное приходит, хотя лимит дня исчерпан
  const pressed = await press(mine!, callbackOf(mine!, "snooze"));
  assert.match(String(pressed.find((m) => m.method === "editMessageText")?.body.text), /⏰ Напомню в 15:05\.$/);
  assert.deepEqual(await run(local("2026-11-06", "15:00")), []);
  assert.equal((await run(local("2026-11-06", "15:05")))[0]?.body.text, "🔔 Позвонить в кафе");
  assert.deepEqual(await run(local("2026-11-06", "21:00")), []);

  // Суббота: «Как прошло?» и вторая подсказка
  const saturday = await run(local("2026-11-07", "11:00"));
  assert.deepEqual(
    saturday.map((m) => String(m.body.text).slice(0, 2)),
    ["🤝", "✉️"],
  );
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM reminders WHERE status = 'waiting' AND due_at <= ?", utc(clock)), 0);
});

test("«Написать ещё раз»: WhatsApp с вежливым текстом и ссылкой на профиль, номер нигде не записан", async () => {
  await setup();
  await createProfile();
  await application(1, { stage: "sent", method: "whatsapp" });
  const [m] = await run(local("2026-11-06", "11:00"));
  assert.ok(m);
  const wa = buttons(m)[0]!;
  assert.equal(wa.text, "💬 Написать в WhatsApp");
  const text = decodeURIComponent(new URL(wa.url!).searchParams.get("text")!);
  assert.match(wa.url!, /^https:\/\/wa\.me\/77011234567\?text=/);
  assert.match(text, /^Здравствуйте! Напоминаю о своём отклике на вакансию «Бариста 1»\. Вакансия ещё актуальна\?\nМой профиль: https:\/\/p\.vacante\.kz\/\w{8}$/);
  assert.deepEqual(buttons(m).slice(1).map((b) => b.text), ["Не надо", "🔕 Не присылать такие"]);
  assert.equal(m.body.chat_id, AIGERIM.id);

  // «Не надо» убирает напоминание и кнопки
  const pressed = await press(m, callbackOf(m, "no"));
  const edit = pressed.find((x) => x.method === "editMessageText");
  assert.match(String(edit?.body.text), /\n\nХорошо, не будем\.$/);
  assert.equal(edit?.body.reply_markup, undefined);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM reminders WHERE kind = 'write_again' AND status = 'dismissed' AND closed_by = 'seeker'"), 1);

  // Повторное нажатие: напоминание уже закрыто
  const again = await press(m, callbackOf(m, "no"));
  assert.equal(again.find((x) => x.method === "answerCallbackQuery")?.body.text, "Это напоминание уже неактуально.");

  const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  for (const { name } of tables) {
    const rows = s.db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
    assert.equal(JSON.stringify(rows).includes("7011234567"), false, `номер в таблице ${name}`);
  }
});

test("кнопки «Пригласили», «Не присылать такие», «Опаздываю» и «Записать кружок»", async () => {
  await setup();
  await createProfile();
  const id = await application(1, { stage: "sent", method: "call" });
  const [check] = await run(local("2026-11-11", "11:00"));
  assert.match(String(check?.body.text), /^❓ Что с откликом на «Бариста 1» \(Кафе «Зерно»\)\? Прошла неделя/);
  assert.deepEqual(buttons(check!).map((b) => b.text), ["🎉 Пригласили", "Отказали", "Тишина", "🔕 Не присылать такие"]);

  // Чужое напоминание не нажмётся
  const other = { id: 7002, first_name: "Ерлан", language_code: "kk" };
  const foreign = await press(check!, callbackOf(check!, "invited"), other);
  assert.equal(foreign.find((x) => x.method === "answerCallbackQuery")?.body.text, "Бұл еске салғыш енді өзекті емес.");

  // «Пригласили» меняет стадию отклика, приложение открывать не нужно
  const pressed = await press(check!, callbackOf(check!, "invited"));
  assert.match(String(pressed.find((x) => x.method === "editMessageText")?.body.text), /✓ Отмечено: Пригласили\.$/);
  const view = await api("GET", `/me/applications/${id}`);
  assert.equal(view.stage, "invited");
  assert.equal(view.events.at(-1).by, "seeker");

  // Собеседование: «Опаздываю» присылает готовый текст с кнопкой WhatsApp
  await api("PATCH", `/me/applications/${id}`, { interview_at: utc(local("2026-11-12", "15:00")) });
  const [soon] = await run(local("2026-11-12", "13:00"));
  assert.ok(soon);
  const late = await press(soon, callbackOf(soon, "late"));
  const text = late.find((x) => x.method === "sendMessage");
  assert.match(String(text?.body.text), /^Текст для работодателя, его можно скопировать:\n\nЗдравствуйте! Это Айгерим, у меня в 15:00 собеседование по вакансии «Бариста 1»\. Немного опаздываю/);
  assert.match(buttons(text!)[0]!.url!, /^https:\/\/wa\.me\/77011234567\?text=/);
  // Под напоминанием кнопки остаются: может, ещё понадобится карта
  assert.equal(late.some((x) => x.method === "editMessageText"), false);

  // «Не присылать такие»: группа выключается, в профиле это видно
  const off = await press(soon, callbackOf(soon, "off"));
  assert.match(String(off.find((x) => x.method === "editMessageText")?.body.text), /больше не придут/);
  const after = await reminders();
  assert.deepEqual(after.settings, { off: ["interviews"], bot: true });
  assert.equal(after.reminders.filter((r) => r.active && r.kind.startsWith("interview")).length, 0);
  assert.equal(after.reminders.filter((r) => r.active && r.kind === "how_was_it").length, 0);

});

test("«Записать кружок» на следующий день после профиля, пока кружка нет", async () => {
  await setup();
  await createProfile();
  const [video] = await run(local("2026-11-05", "11:00"));
  assert.ok(video);
  assert.match(String(video.body.text), /^🎥 Профиль с кружком открывают охотнее/);
  const prompt = await press(video, callbackOf(video, "video"));
  assert.match(String(prompt.find((x) => x.method === "sendMessage")?.body.text), /^🎥 Запишите кружок для профиля/);
  assert.match(String(prompt.find((x) => x.method === "editMessageText")?.body.text), /\n\n✅ Готово\.$/);

  // Кружок записали раньше: напоминание отменяется и не приходит
  const other = { id: 7002, first_name: "Ерлан" };
  clock = NOW;
  await createProfile(other);
  assert.equal((await active(other)).filter((r) => r.startsWith("profile")).length, 1);
  putVideo(s.db, other.id, { file_id: "f", file_unique_id: "u", file: "f.mp4", poster: null, duration: 30, size: 100, recorded_at: utc(clock) });
  assert.equal((await active(other)).filter((r) => r.startsWith("profile")).length, 0);
  assert.deepEqual(await run(local("2026-11-05", "11:00")), []);
});

test("свои напоминания и настройки в приложении", async () => {
  await setup();
  await createProfile();
  const bad = [
    { text: "", at: utc(NOW + 3_600_000) },
    { text: "Позвонить", at: "завтра" },
    { text: "Позвонить", at: utc(NOW - 86_400_000) },
    { text: "Позвонить", at: utc(NOW + 200 * 86_400_000) },
  ];
  for (const body of bad) assert.equal((await s.call("POST", "/me/reminders", { headers: auth(), body })).status, 400);

  const created = await api("POST", "/me/reminders", { text: "  Позвонить   в кафе\nв среду ", at: utc(local("2026-11-04", "15:00")) });
  const mine = created.reminders.find((r: View) => r.id === created.id);
  assert.equal(mine.text, "Позвонить в кафе в среду");
  assert.equal(mine.kind, "custom");
  assert.equal(created.due, 1);

  // «Отложить» из приложения: на час, но в окне с 9 до 21
  clock = local("2026-11-04", "20:30");
  const snoozed = await api("PATCH", `/me/reminders/${created.id}`, { action: "snooze" });
  assert.equal(snoozed.reminders.find((r: View) => r.id === created.id).due_at, utc(local("2026-11-05", "09:00")));
  const done = await api("PATCH", `/me/reminders/${created.id}`, { action: "done" });
  const closed = done.reminders.find((r: View) => r.id === created.id);
  assert.deepEqual([closed.status, closed.active], ["done", false]); // в истории
  assert.equal((await s.call("PATCH", `/me/reminders/${created.id}`, { headers: auth(), body: { action: "done" } })).status, 404);
  assert.equal((await s.call("PATCH", "/me/reminders/abc", { headers: auth(), body: { action: "done" } })).status, 404);
  assert.equal((await s.call("PATCH", `/me/reminders/${created.id}`, { headers: auth(), body: { action: "sleep" } })).status, 400);

  // Чужое не трогается
  const other = { id: 7002, first_name: "Ерлан" };
  await createProfile(other, "kk");
  const theirs = await api("POST", "/me/reminders", { text: "Менікі", at: utc(clock + 3_600_000) }, other);
  assert.equal((await s.call("PATCH", `/me/reminders/${theirs.id}`, { headers: auth(), body: { action: "dismiss" } })).status, 404);
  await api("PATCH", `/me/reminders/${theirs.id}`, { action: "dismiss" }, other);

  // Настройки: какие группы выключены и присылать ли в бот
  assert.equal((await s.call("PUT", "/me/reminders/settings", { headers: auth(), body: { off: ["nope"], bot: true } })).status, 400);
  assert.equal((await s.call("PUT", "/me/reminders/settings", { headers: auth(), body: { off: [] } })).status, 400);
  await application(1, { stage: "sent", method: "whatsapp" });
  assert.equal((await active()).filter((r) => r.startsWith("write_again")).length, 1);
  const saved = await api("PUT", "/me/reminders/settings", { off: ["applications", "profile"], bot: false });
  assert.deepEqual(saved.settings, { off: ["applications", "profile"], bot: false });
  assert.deepEqual(await active(), []);

  // Бот выключен: в приложении напоминание есть, в чат не приходит
  await api("POST", "/me/reminders", { text: "Купить санкнижку", at: utc(local("2026-11-05", "10:00")) });
  assert.deepEqual(await run(local("2026-11-05", "10:00")), []);
  assert.equal((await reminders()).due, 1);
  await api("PUT", "/me/reminders/settings", { off: [], bot: true });
  assert.equal((await run(local("2026-11-05", "10:05")))[0]?.body.text, "🔔 Купить санкнижку");

  // Удаление профиля стирает и напоминания
  await api("DELETE", "/me");
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM reminders WHERE seeker_id = ?", AIGERIM.id), 0);
  assert.equal((await s.call("GET", "/me/reminders", { headers: auth() })).status, 404);
});

test("человек заблокировал бота: напоминание не повторяется, в приложении оно есть", async () => {
  const sent: Sent[] = [];
  const blocked = new Bot(TOKEN, (async (url: string | URL, init?: RequestInit) => {
    sent.push({ method: String(url).split("/").pop() ?? "", body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }));
  }) as typeof fetch);
  await setup(blocked);
  await createProfile();
  await api("POST", "/me/reminders", { text: "Позвонить", at: utc(local("2026-11-04", "12:00")) });
  clock = local("2026-11-04", "12:00");
  await runReminders(deps);
  await runReminders(deps);
  assert.equal(sent.filter((m) => m.method === "sendMessage").length, 1);
  const [r] = (await reminders()).reminders;
  assert.deepEqual([r?.status, r?.active], ["sent", true]);
});

test("/otkliki и /napominaniya в боте", async () => {
  await setup();
  // Без профиля: предложение его создать
  const none = await say("/otkliki");
  assert.equal(none.handled, true);
  assert.match(String(none.sent[0]?.body.text), /^Отклики и напоминания хранятся в профиле/);
  assert.match(buttons(none.sent[0]!)[0]!.web_app!.url, /\/app\/\?tab=profile$/);

  await createProfile();
  const fresh = await say("/napominaniya@vacantekz_bot");
  assert.equal(fresh.sent[0]?.body.text, "🔔 Напоминания\n\nЗавтра\n• 11:00 Записать кружок для профиля");
  await api("PUT", "/me/reminders/settings", { off: ["profile"], bot: true });
  assert.match(String((await say("/napominaniya")).sent[0]?.body.text), /^Напоминаний пока нет/);
  await api("PUT", "/me/reminders/settings", { off: [], bot: true });

  await application(1, { stage: "interview", interview_at: utc(local("2026-11-05", "15:00")) });
  await application(2, { stage: "sent", method: "whatsapp" });
  await application(3, { stage: "offer", start_at: "2026-11-09" });
  await api("POST", "/me/applications", { vacancy: vacancy(4) });

  const apps = await say("/otkliki");
  assert.equal(
    apps.sent[0]?.body.text,
    "📋 Ваши отклики\n\nСобеседования\n• Бариста 1, Кафе «Зерно»: собеседование завтра в 15:00\n\n" +
      "Работа\n• Бариста 3, Кафе «Зерно»: выход 9 ноября\n\nЖдут ответа\n• Бариста 2, Кафе «Зерно»: отправлен\n\nНравится: 1",
  );
  assert.match(buttons(apps.sent[0]!)[0]!.web_app!.url, /\/app\/\?tab=applications&city=almaty$/);

  const list = await say("/napominaniya");
  assert.equal(
    list.sent[0]?.body.text,
    "🔔 Напоминания\n\nСегодня\n• 19:00 Собеседование: «Бариста 1»\n\n" +
      "Завтра\n• 11:00 Записать кружок для профиля\n• 13:00 Собеседование: «Бариста 1»\n\n" +
      "Позже\n• 6 ноября в 10:00 Как прошло собеседование?: «Бариста 1»\n• 6 ноября в 11:00 Написать ещё раз: «Бариста 2»\n" +
      "• 8 ноября в 19:00 Выход на работу: «Бариста 3»\n• 11 ноября в 11:00 Что с откликом?: «Бариста 2»",
  );
  assert.match(buttons(list.sent[0]!)[0]!.web_app!.url, /\/app\/\?tab=reminders&city=almaty$/);

  // Обычный текст сервер не трогает
  assert.equal((await say("/otkliki_list")).handled, false);
});

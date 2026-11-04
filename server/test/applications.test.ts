import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { contactsOf, LookupLimit, postParts } from "../src/contacts.ts";
import { newsText } from "../src/notify.ts";
import { dateTimeLabel, fromLocal, quietHours, weekStart } from "../src/time.ts";
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
const VACANCY = {
  id: "almatyrabota1-21258",
  title: "Бариста",
  title_kk: "Бариста (кк)",
  employer: "Кафе «Зерно»",
  city: "almaty",
  address: "ул. Сыганак, 2",
  map: "https://2gis.kz/almaty/search/%D1%83%D0%BB.%20%D0%A1%D1%8B%D0%B3%D0%B0%D0%BD%D0%B0%D0%BA%2C%202",
  url: "https://vacante.kz/v/almatyrabota1-21258/",
  source_url: "https://t.me/almatyrabota1/21258",
  contact: ["whatsapp", "phone", "nonsense"],
  pay: "лишнее поле не сохраняется",
};
const OTHER = { id: 7002, first_name: "Ерлан", language_code: "kk" };

const auth = (user: Record<string, unknown> = AIGERIM) => ({ authorization: `tma ${initDataFor(user)}` });
const profileHost = { host: "p.vacante.kz" };

/** Страница поста на t.me так, как её отдаёт ?embed=1. */
const embed = (channel: string, id: number, text: string) =>
  `<!DOCTYPE html><html><body class="body_widget_post"><div class="tgme_widget_message_wrap js-widget_message_wrap">` +
  `<div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="${channel}/${id}" data-view="x">` +
  `<div class="tgme_widget_message_user"><a href="https://t.me/${channel}"></a></div><div class="tgme_widget_message_bubble">` +
  `<div class="tgme_widget_message_author accent_color"><a class="tgme_widget_message_owner_name" href="https://t.me/${channel}">` +
  `<span dir="auto">Работа Алматы</span></a></div>` +
  `<div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div>` +
  `<div class="tgme_widget_message_footer compact js-message_footer"><a class="tgme_widget_message_date" href="https://t.me/${channel}/${id}">` +
  `<time datetime="2026-11-04T05:00:00+00:00" class="time">10:00</time></a></div></div></div></div></body></html>`;

const POST_HTML = embed(
  "almatyrabota1",
  21258,
  "Требуется бариста в кофейню «Зерно»<br/>2/2, 12 000 тг за смену<br/>WhatsApp: 8 701 123 45 67<br/>" +
    'Резюме: <a href="https://t.me/hr_zerno" target="_blank">@hr_zerno</a><br/><br/>' +
    'Подписывайтесь на <a href="https://t.me/almatyrabota1">@almatyrabota1</a>, по вопросам рекламы 8 777 000 00 00',
);

// Ответы t.me для сервера: адрес → страница. fail — сеть не ответила
const pages = new Map<string, string>();
const fetched: string[] = [];
let fail = false;
const fakeFetch = (async (url: string | URL) => {
  const href = String(url);
  fetched.push(href);
  if (fail) throw new Error("сеть недоступна");
  return new Response(pages.get(href) ?? "<html><body>Post not found</body></html>", { status: 200 });
}) as typeof fetch;

let s: TestServer;
before(async () => {
  pages.set("https://t.me/almatyrabota1/21258?embed=1&mode=tme", POST_HTML);
  s = await startServer({ fetch: fakeFetch });
});
after(() => s.close());

async function createProfile(user: { id: number; first_name: string } = AIGERIM, lang = "ru") {
  const r = await s.call("PUT", "/me/profile", {
    headers: { ...auth(user), "x-vacante-beta": "1" },
    body: { consent: CONSENT, profile: { ...ANKETA, name: user.first_name }, lang },
  });
  assert.equal(r.status, 201, r.text);
}

/** Есть ли строка хоть в одной ячейке базы: так проверяем, что номер работодателя нигде не записан. */
function inDatabase(needle: string): boolean {
  const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return tables.some(({ name }) =>
    (s.db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]).some((row) =>
      Object.values(row).some((v) => String(v).includes(needle)),
    ),
  );
}

test("время Казахстана: неделя с понедельника, поле даты, подписи", () => {
  // Среда 4 ноября 11:00 в Алматы → неделя с понедельника 2 ноября 00:00 (1 ноября 19:00 UTC)
  assert.equal(new Date(weekStart(NOW)).toISOString(), "2026-11-01T19:00:00.000Z");
  assert.equal(fromLocal("2026-11-05T15:00"), Date.parse("2026-11-05T10:00:00Z"));
  assert.equal(fromLocal("2026-11-31T10:00"), null);
  assert.equal(fromLocal("2026-11-05T25:00"), null);
  assert.equal(fromLocal("завтра"), null);
  assert.equal(dateTimeLabel(Date.parse("2026-11-05T10:00:00Z"), "ru"), "5 ноября в 15:00");
  assert.equal(dateTimeLabel(Date.parse("2026-11-05T10:00:00Z"), "kk"), "5 қараша, 15:00");
  assert.equal(quietHours(Date.parse("2026-11-04T16:30:00Z")), true); // 21:30
  assert.equal(quietHours(Date.parse("2026-11-04T04:00:00Z")), false); // 9:00
});

test("контакт работодателя: из текста и ссылок поста, без подписей канала", () => {
  const parts = postParts(POST_HTML, "almatyrabota1", "21258");
  assert.ok(parts);
  assert.match(parts.text, /WhatsApp: 8 701 123 45 67/);
  // Ссылку на сам канал отбрасывает уже contactsOf, как и vacante/contacts.py
  assert.deepEqual(parts.links, ["https://t.me/hr_zerno", "https://t.me/almatyrabota1"]);
  assert.deepEqual(contactsOf(parts.text, parts.links, "almatyrabota1"), {
    whatsapp: "+77011234567",
    phone: "+77011234567",
    telegram: "hr_zerno",
  });
  assert.equal(postParts(POST_HTML, "almatyrabota1", "99999"), null);

  const none = { whatsapp: null, phone: null, telegram: null };
  // Городской номер: позвонить можно, WhatsApp нет
  assert.deepEqual(contactsOf("Звоните +7 (727) 300-00-00", [], "jobs"), { ...none, phone: "+77273000000" });
  // Номер спрятан за подписью ссылки
  assert.deepEqual(contactsOf("Написать в WhatsApp", ["https://wa.me/87011234567"], "jobs"), {
    ...none,
    whatsapp: "+77011234567",
    phone: "+77011234567",
  });
  assert.deepEqual(contactsOf("Написать", ["https://api.whatsapp.com/send?text=hi&phone=77011234567"], "jobs").whatsapp, "+77011234567");
  assert.deepEqual(contactsOf("Позвонить", ["tel:+77011234567"], "jobs"), { ...none, phone: "+77011234567", whatsapp: "+77011234567" });
  // Российский номер, сам канал, служебные адреса и рекламные строки — не контакт
  assert.deepEqual(contactsOf("Тел. +7 916 123-45-67", [], "jobs"), none);
  assert.deepEqual(
    contactsOf("Вакансии: t.me/jobs\nПо вопросам рекламы: @admin_jobs, 8 777 000 00 00", ["https://t.me/jobs/5", "https://t.me/share/url"], "jobs"),
    none,
  );
  // Почта с кириллицей перед @ не имя в Telegram
  assert.deepEqual(contactsOf("Пишите: кадры@mail.kz", [], "jobs"), none);
});

test("номер из поста: только в момент отклика, без профиля тоже, нигде не записывается", async () => {
  const body = { vacancy_id: VACANCY.id, source_url: VACANCY.source_url };
  assert.equal((await s.call("POST", "/me/contact", { body })).status, 401);
  const hh = await s.call("POST", "/me/contact", {
    headers: auth(),
    body: { vacancy_id: "hh-1", source_url: "https://hh.kz/vacancy/1" },
  });
  assert.equal(hh.status, 400); // с hh.kz контакты не берём
  const evil = await s.call("POST", "/me/contact", {
    headers: auth(),
    body: { vacancy_id: "x-1", source_url: "https://t.me/almatyrabota1/1?embed=1#@evil.example" },
  });
  assert.equal(evil.status, 400);

  // Профиля у Айгерим ещё нет: номер всё равно можно узнать
  const r = await s.call("POST", "/me/contact", { headers: auth(), body });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { whatsapp: "+77011234567", phone: "+77011234567", telegram: "hr_zerno", left: 29 });
  assert.equal(fetched.at(-1), "https://t.me/almatyrabota1/21258?embed=1&mode=tme");
  assert.match(String(r.headers["cache-control"]), /no-store/);
  // Повторно та же вакансия в тот же день — бесплатно
  assert.equal((await s.call("POST", "/me/contact", { headers: auth(), body })).json.left, 29);

  // Пост удалили: контакта нет
  const gone = await s.call("POST", "/me/contact", {
    headers: auth(),
    body: { vacancy_id: "almatyrabota1-5", source_url: "https://t.me/almatyrabota1/5" },
  });
  assert.deepEqual(gone.json, { whatsapp: null, phone: null, telegram: null, left: 28 });

  // Telegram не ответил: попытка не считается
  fail = true;
  const down = await s.call("POST", "/me/contact", {
    headers: auth(),
    body: { vacancy_id: "almatyrabota1-6", source_url: "https://t.me/almatyrabota1/6" },
  });
  fail = false;
  assert.equal(down.status, 502);

  assert.equal(inDatabase("7011234567"), false);
  assert.equal(inDatabase("hr_zerno"), false);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM seekers"), 0);
});

test("не больше 30 вакансий с номером в день, назавтра снова можно", () => {
  const limit = new LookupLimit(30);
  for (let i = 0; i < 30; i++) assert.equal(limit.take(1, `v-${i}`, NOW).ok, true);
  assert.deepEqual(limit.take(1, "v-30", NOW), { ok: false, left: 0 });
  assert.deepEqual(limit.take(1, "v-3", NOW), { ok: true, left: 0 }); // уже открытая
  assert.equal(limit.take(2, "v-30", NOW).ok, true); // у другого человека свой счёт
  // Полночь в Алматы — 19:00 UTC
  assert.equal(limit.take(1, "v-30", Date.parse("2026-11-04T19:00:00Z")).ok, true);
  limit.refund(1, "v-30");
  assert.equal(limit.take(1, "v-30", Date.parse("2026-11-04T19:00:00Z")).left, 29);
});

test("частые запросы номера упираются в ограничение", async () => {
  const user = { id: 7300, first_name: "Спешу" };
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) {
    const r = await s.call("POST", "/me/contact", {
      headers: auth(user),
      body: { vacancy_id: `almatyrabota1-${100 + i}`, source_url: `https://t.me/almatyrabota1/${100 + i}` },
    });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429]);
});

let appId = 0;
let code = "";

test("отклик: копия вакансии, своя ссылка и готовый текст", async () => {
  assert.equal((await s.call("POST", "/me/applications", { headers: auth(), body: { vacancy: VACANCY } })).status, 404);
  await createProfile();
  const r = await s.call("POST", "/me/applications", { headers: auth(), body: { vacancy: VACANCY, lang: "ru" } });
  assert.equal(r.status, 201, r.text);
  const app = r.json.application;
  appId = app.id;
  code = app.link.code;
  assert.equal(app.stage, "liked");
  assert.equal(app.sent_at, null);
  assert.equal(app.link.url, `https://p.vacante.kz/${code}`);
  assert.deepEqual(app.vacancy, {
    id: VACANCY.id,
    title: "Бариста",
    title_kk: "Бариста (кк)",
    employer: "Кафе «Зерно»",
    city: "almaty",
    address: "ул. Сыганак, 2",
    map: VACANCY.map,
    url: VACANCY.url,
    source_url: VACANCY.source_url,
    contact: ["whatsapp", "phone"],
  });
  assert.deepEqual(r.json.message, {
    text: "Здравствуйте! Пишу по вакансии «Бариста». Меня зовут Айгерим. Опыт 1–3 года. Могу выйти на этой неделе.",
    link_text: `Мой профиль: https://p.vacante.kz/${code}`,
  });
  // Ссылка отклика живёт 60 дней
  const link = s.db.prepare("SELECT application_id, expires_at FROM links WHERE code = ?").get(code) as Record<string, unknown>;
  assert.deepEqual({ ...link }, { application_id: appId, expires_at: "2027-01-03T06:00:00Z" });

  // Повторно та же вакансия: тот же отклик и та же ссылка, текст на казахском
  const again = await s.call("POST", "/me/applications", { headers: auth(), body: { vacancy: VACANCY, lang: "kk" } });
  assert.equal(again.status, 200);
  assert.equal(again.json.application.id, appId);
  assert.equal(again.json.application.link.code, code);
  assert.equal(
    again.json.message.text,
    "Сәлеметсіз бе! «Бариста (кк)» бос орны бойынша жазып отырмын. Менің атым Айгерим. Тәжірибем 1–3 жыл. Осы аптада шыға аламын.",
  );
  assert.equal(again.json.message.link_text, `Профилім: https://p.vacante.kz/${code}`);

  for (const vacancy of [{ ...VACANCY, id: "../etc" }, { ...VACANCY, title: " " }, { ...VACANCY, url: "http://vacante.kz/v/1/" }]) {
    assert.equal((await s.call("POST", "/me/applications", { headers: auth(), body: { vacancy } })).status, 400);
  }
});

test("стадии отклика и история: кто и когда поменял", async () => {
  const sent = await s.call("PATCH", `/me/applications/${appId}`, {
    headers: auth(),
    body: { stage: "sent", method: "whatsapp" },
  });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json.application.stage, "sent");
  assert.equal(sent.json.application.method, "whatsapp");
  assert.equal(sent.json.application.sent_at, "2026-11-04T06:00:00Z");
  assert.equal(sent.json.summary.stage, "applying");
  assert.equal(sent.json.summary.week.sent, 1);

  // «Просмотрен» ставит только открытие ссылки работодателем
  assert.equal((await s.call("PATCH", `/me/applications/${appId}`, { headers: auth(), body: { stage: "seen" } })).status, 400);
  assert.equal((await s.call("PATCH", `/me/applications/${appId}`, { headers: auth(), body: { note: "x".repeat(600) } })).json.application.note.length, 500);
  assert.equal((await s.call("PATCH", `/me/applications/${appId}`, { headers: auth(), body: { start_at: "2026-02-30" } })).status, 400);
  // Чужой отклик не виден и не меняется
  await createProfile(OTHER, "kk");
  assert.equal((await s.call("GET", `/me/applications/${appId}`, { headers: auth(OTHER) })).status, 404);
  assert.equal((await s.call("PATCH", `/me/applications/${appId}`, { headers: auth(OTHER), body: { stage: "hired" } })).status, 404);
  assert.equal((await s.call("DELETE", `/me/applications/${appId}`, { headers: auth(OTHER) })).status, 404);

  const one = await s.call("GET", `/me/applications/${appId}`, { headers: auth() });
  assert.deepEqual(
    one.json.events.map((e: { stage: string; by: string }) => `${e.stage}:${e.by}`),
    ["liked:seeker", "sent:seeker"],
  );
});

test("работодатель открыл ссылку отклика: «Просмотрен» и сообщение кандидату", async () => {
  // Превью ссылки в WhatsApp не считается
  await s.call("GET", `/${code}`, { ...profileHost, headers: { "user-agent": "WhatsApp/2.24.1 A" } });
  assert.equal((await s.call("GET", `/me/applications/${appId}`, { headers: auth() })).json.stage, "sent");
  s.sent.length = 0;

  const page = await s.call("GET", `/${code}`, { ...profileHost, headers: { "user-agent": BROWSER } });
  assert.equal(page.status, 200);
  assert.match(page.text, /Отклик на вакансию «Бариста»/);
  assert.match(page.text, /Пригласить на собеседование/);
  assert.match(page.text, new RegExp(`action="/${code}/answer"`));
  await s.idle();
  const app = (await s.call("GET", `/me/applications/${appId}`, { headers: auth() })).json;
  assert.equal(app.stage, "seen");
  assert.equal(app.views, 1);
  assert.equal(app.seen_at, "2026-11-04T06:00:00Z");
  assert.deepEqual(app.events.at(-1), { stage: "seen", by: "employer", at: "2026-11-04T06:00:00Z" });
  // В «Кто смотрел» видно заведение из отклика
  const views = (await s.call("GET", "/me/views", { headers: auth() })).json.views;
  assert.deepEqual(views[0], { at: "2026-11-04T06:00:00Z", via: "application", viewer: "Кафе «Зерно»", phone_shown: false });

  const [news] = s.sent.filter((m) => m.method === "sendMessage");
  assert.ok(news);
  assert.equal(news.body.chat_id, AIGERIM.id);
  assert.equal(news.body.disable_notification, false); // 11:00 в Алматы
  assert.match(String(news.body.text), /Ваш профиль открыли по отклику «Бариста» \(Кафе «Зерно»\)/);
  const button = (news.body.reply_markup as { inline_keyboard: { text: string; web_app: { url: string } }[][] }).inline_keyboard[0]![0]!;
  assert.equal(button.web_app.url, "https://vacante.kz/app/?tab=applications&city=almaty");

  // Второе открытие: стадия та же, второго сообщения нет
  s.sent.length = 0;
  await s.call("GET", `/${code}`, { ...profileHost, headers: { "user-agent": BROWSER, cookie: `v_${code}=1` } });
  await s.idle();
  assert.equal(s.sent.length, 0);
});

test("работодатель отвечает на странице: приглашение со временем, отказ", async () => {
  const answer = (form: string) =>
    s.call("POST", `/${code}/answer`, {
      ...profileHost,
      headers: { "user-agent": BROWSER, "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
  s.sent.length = 0;

  const past = await answer("answer=invite&at=2026-11-03T15%3A00");
  assert.equal(past.status, 303);
  assert.equal(past.headers.location, `/${code}?error=date#answer`);
  const withError = await s.call("GET", `/${code}?error=date`, { ...profileHost, headers: { "user-agent": BROWSER } });
  assert.match(withError.text, /Проверьте дату/);

  const invite = await answer("answer=invite&at=2026-11-05T15%3A00");
  assert.equal(invite.status, 303);
  assert.equal(invite.headers.location, `/${code}#answer`);
  await s.idle();
  let app = (await s.call("GET", `/me/applications/${appId}`, { headers: auth() })).json;
  assert.equal(app.stage, "interview");
  assert.equal(app.interview_at, "2026-11-05T10:00:00Z");
  assert.deepEqual(app.events.at(-1), { stage: "interview", by: "employer", at: "2026-11-04T06:00:00Z" });
  const messages = () => s.sent.filter((m) => m.method === "sendMessage").map((m) => String(m.body.text));
  assert.deepEqual(messages(), [
    "🎉 Вас приглашают на собеседование по отклику «Бариста» (Кафе «Зерно»).\nКогда: 5 ноября в 15:00.\nАдрес: ул. Сыганак, 2.",
  ]);
  const shown = await s.call("GET", `/${code}`, { ...profileHost, headers: { "user-agent": BROWSER } });
  assert.match(shown.text, /Вы пригласили кандидата на собеседование: 5 ноября в 15:00/);
  assert.match(shown.text, /value="2026-11-05T15:00"/);

  // Та же кнопка ещё раз: кандидату второй раз не пишем
  await answer("answer=invite&at=2026-11-05T15%3A00");
  await s.idle();
  assert.equal(messages().length, 1);

  const summary = (await s.call("GET", "/me/applications", { headers: auth() })).json.summary;
  assert.equal(summary.stage, "interviews");
  assert.deepEqual(summary.week, { from: "2026-11-01T19:00:00Z", sent: 1, seen: 1, invited: 1 });
  assert.equal(summary.next_interview.at, "2026-11-05T10:00:00Z");

  const reject = await answer("answer=reject");
  assert.equal(reject.status, 303);
  await s.idle();
  app = (await s.call("GET", `/me/applications/${appId}`, { headers: auth() })).json;
  assert.equal(app.stage, "rejected");
  assert.match(messages().at(-1)!, /Ответ по отклику «Бариста» \(Кафе «Зерно»\): пока не подходит/);
  assert.match((await s.call("GET", `/${code}`, { ...profileHost, headers: { "user-agent": BROWSER } })).text, /Вы ответили «Не подходит»/);

  // Кандидат вышел на работу: отвечать на странице больше нечего
  await s.call("PATCH", `/me/applications/${appId}`, { headers: auth(), body: { stage: "hired" } });
  const hired = await s.call("GET", `/${code}`, { ...profileHost, headers: { "user-agent": BROWSER } });
  assert.doesNotMatch(hired.text, /Пригласить на собеседование/);
  assert.equal((await s.call("GET", "/me/applications", { headers: auth() })).json.summary.stage, "working");

  // По общей ссылке профиля отвечать не на что
  const shared = (await s.call("POST", "/me/link", { headers: auth() })).json.code;
  assert.equal((await s.call("POST", `/${shared}/answer`, { ...profileHost, body: "answer=invite", headers: { "content-type": "application/x-www-form-urlencoded" } })).status, 404);
});

test("дата собеседования от кандидата сама ставит «Собеседование»", async () => {
  const r = await s.call("POST", "/me/applications", {
    headers: auth(),
    body: { vacancy: { ...VACANCY, id: "almatyrabota1-30000", employer: null } },
  });
  const id = r.json.application.id;
  const patched = await s.call("PATCH", `/me/applications/${id}`, {
    headers: auth(),
    body: { interview_at: "2026-11-06T05:30:00Z", note: "Спросить Асель" },
  });
  assert.equal(patched.json.application.stage, "interview");
  assert.equal(patched.json.application.sent_at, "2026-11-04T06:00:00Z");
  assert.equal(patched.json.application.note, "Спросить Асель");
  assert.equal((await s.call("PATCH", `/me/applications/${id}`, { headers: auth(), body: { interview_at: "2027-12-01T10:00:00Z" } })).status, 400);
});

test("удалить отклик: ссылка на профиль перестаёт открываться", async () => {
  const r = await s.call("POST", "/me/applications", {
    headers: auth(),
    body: { vacancy: { ...VACANCY, id: "almatyrabota1-40000" } },
  });
  const linkCode = r.json.application.link.code;
  assert.equal((await s.call("GET", `/${linkCode}`, { ...profileHost, headers: { "user-agent": BROWSER } })).status, 200);
  const del = await s.call("DELETE", `/me/applications/${r.json.application.id}`, { headers: auth() });
  assert.equal(del.status, 200);
  assert.equal((await s.call("GET", `/${linkCode}`, { ...profileHost, headers: { "user-agent": BROWSER } })).status, 404);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM application_events WHERE application_id = ?", r.json.application.id), 0);
});

test("лайки с телефона переезжают в отклики", async () => {
  const items = [
    { vacancy: { ...VACANCY, id: "hh-501", source_url: "https://hh.kz/vacancy/501", contact: [] }, liked_at: "2026-11-01T10:00:00Z" },
    {
      vacancy: { ...VACANCY, id: "almatyrabota1-502" },
      stage: "sent",
      method: "whatsapp",
      liked_at: "2026-11-02T10:00:00Z",
      sent_at: "2026-11-02T10:05:00Z",
    },
    { vacancy: VACANCY, liked_at: "2026-10-20T10:00:00Z" }, // уже есть
    { vacancy: { ...VACANCY, id: "almatyrabota1-503" }, liked_at: "2030-01-01T00:00:00Z" }, // дата из будущего
    {
      vacancy: { ...VACANCY, id: "almatyrabota1-504" },
      stage: "interview",
      method: "call",
      interview_at: "2026-11-06T05:00:00Z",
      note: "Спросить Асель",
      liked_at: "2026-11-03T10:00:00Z",
      sent_at: "2026-11-03T10:01:00Z",
    },
  ];
  const r = await s.call("POST", "/me/applications/import", { headers: auth(OTHER), body: { items } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.imported, 5); // у Ерлана своих откликов ещё не было
  const byId = Object.fromEntries(r.json.applications.map((a: { vacancy: { id: string } }) => [a.vacancy.id, a]));
  assert.equal(byId["hh-501"].stage, "liked");
  assert.equal(byId["hh-501"].created_at, "2026-11-01T10:00:00Z");
  assert.equal(byId["hh-501"].link, null); // ссылка появится, когда он соберётся откликнуться
  assert.equal(byId["almatyrabota1-502"].stage, "sent");
  assert.equal(byId["almatyrabota1-502"].sent_at, "2026-11-02T10:05:00Z");
  assert.equal(byId["almatyrabota1-503"].created_at, "2026-11-04T06:00:00Z");
  const interview = byId["almatyrabota1-504"];
  assert.deepEqual(
    [interview.stage, interview.method, interview.interview_at, interview.note, interview.sent_at],
    ["interview", "call", "2026-11-06T05:00:00Z", "Спросить Асель", "2026-11-03T10:01:00Z"],
  );
  const events = (await s.call("GET", `/me/applications/${interview.id}`, { headers: auth(OTHER) })).json.events;
  assert.deepEqual(
    events.map((e: { stage: string; at: string }) => `${e.stage}@${e.at}`),
    ["liked@2026-11-03T10:00:00Z", "sent@2026-11-03T10:01:00Z", "interview@2026-11-04T06:00:00Z"],
  );
  // «Просмотрен» с телефона не переносится (его ставит только работодатель), вакансия с ошибкой пропускается
  const odd = await s.call("POST", "/me/applications/import", {
    headers: auth(OTHER),
    body: { items: [{ vacancy: { ...VACANCY, id: "almatyrabota1-505" }, stage: "seen" }, { vacancy: { id: "x" } }] },
  });
  assert.equal(odd.json.imported, 1);
  const kept = odd.json.applications.find((a: { vacancy: { id: string } }) => a.vacancy.id === "almatyrabota1-505");
  assert.equal(kept.stage, "liked");

  const again = await s.call("POST", "/me/applications/import", { headers: auth(OTHER), body: { items } });
  assert.equal(again.json.imported, 0);
  assert.equal((await s.call("POST", "/me/applications/import", { headers: auth(OTHER), body: { items: "x" } })).status, 400);
});

test("тексты бота на казахском", () => {
  const row = {
    title: "Бариста",
    title_kk: "Бариста",
    employer: null,
    address: null,
    interview_at: null,
  } as unknown as Parameters<typeof newsText>[1];
  assert.equal(
    newsText("invite", row, "kk"),
    "🎉 «Бариста» өтінімі бойынша сұхбатқа шақырады.\nУақытын келісіп, оны «Өтінімдер» бөлімінде көрсетіңіз.",
  );
  assert.match(newsText("seen", row, "kk"), /профиліңізді ашты/);
});

test("удаление профиля стирает и отклики", async () => {
  assert.ok(count(s, "SELECT COUNT(*) AS n FROM applications WHERE seeker_id = ?", OTHER.id) > 0);
  await s.call("DELETE", "/me", { headers: auth(OTHER) });
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM applications WHERE seeker_id = ?", OTHER.id), 0);
});

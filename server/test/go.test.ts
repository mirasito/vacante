// Прямые кнопки связи: /go/<вакансия>/<wa|call|tg> сразу ведёт в WhatsApp, на звонок или в Telegram.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { backfillContacts } from "../src/go.ts";
import { count, startServer, type TestServer } from "./helpers.ts";

const KEY = "ab".repeat(32);
const admin = { authorization: `Bearer ${KEY}` };

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

const POST = embed(
  "almatyrabota1",
  21258,
  "Требуется бариста в кофейню «Зерно»<br/>WhatsApp: 8 701 123 45 67<br/>" +
    'Резюме: <a href="https://t.me/hr_zerno" target="_blank">@hr_zerno</a>',
);
const NO_CONTACTS = embed("almatyrabota1", 21300, "Требуется повар, подробности на собеседовании");

const started: TestServer[] = [];
after(async () => {
  for (const s of started) await s.close().catch(() => undefined);
});

/** Сервер, который вместо t.me читает страницы из pages; fetched — что он запрашивал. */
async function server(pages: Record<string, string> = { "almatyrabota1/21258": POST, "almatyrabota1/21300": NO_CONTACTS }) {
  const fetched: string[] = [];
  let clock = Date.parse("2026-11-04T06:00:00Z");
  const fetchImpl = (async (url: string | URL) => {
    const href = String(url);
    fetched.push(href);
    const m = /^https:\/\/t\.me\/([^/]+\/\d+)\?/.exec(href);
    const page = m ? pages[m[1]!] : undefined;
    return page ? new Response(page) : new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  const s = await startServer({ fetch: fetchImpl, now: () => clock }, { CRM_KEY: KEY });
  started.push(s);
  return { s, fetched, fetchImpl, tick: (ms: number) => void (clock += ms) };
}

test("WhatsApp: сразу в чат с номером из поста и готовым текстом; номер сохраняется на сервере", async () => {
  const { s, fetched } = await server();
  const r = await s.call("GET", "/go/almatyrabota1-21258/wa?s=web&t=" + encodeURIComponent("Бариста"));
  assert.equal(r.status, 302);
  const to = new URL(String(r.headers.location));
  assert.equal(to.origin + to.pathname, "https://wa.me/77011234567");
  assert.equal(to.searchParams.get("text"), "Здравствуйте! Пишу по вакансии «Бариста». Нашёл её на vacante.kz");
  assert.equal(r.headers["x-robots-tag"], "noindex, nofollow");
  assert.deepEqual(
    { ...s.db.prepare("SELECT whatsapp, phone, telegram, found FROM vacancy_contacts WHERE vacancy_id = ?").get("almatyrabota1-21258") },
    { whatsapp: "+77011234567", phone: "+77011234567", telegram: "hr_zerno", found: 1 },
  );
  // Второе нажатие берёт номер из базы, t.me больше не спрашиваем
  await s.call("GET", "/go/almatyrabota1-21258/wa");
  assert.equal(fetched.length, 1);
});

test("Telegram ведёт к работодателю, звонок — на страницу с номером и ссылкой tel:", async () => {
  const { s } = await server();
  const tg = await s.call("GET", "/go/almatyrabota1-21258/tg?s=tg");
  assert.equal(tg.status, 302);
  assert.equal(tg.headers.location, "https://t.me/hr_zerno");
  const call = await s.call("GET", "/go/almatyrabota1-21258/call?s=tg");
  assert.equal(call.status, 200);
  assert.match(call.text, /href="tel:\+77011234567"/);
  assert.match(call.text, /\+7 701 123 45 67/);
  assert.match(call.text, /http-equiv="refresh" content="0;url=tel:\+77011234567"/);
});

test("контакта нет, пост удалён или t.me не ответил: ведём на исходный пост", async () => {
  const { s, fetched } = await server();
  for (const path of ["/go/almatyrabota1-21300/wa", "/go/almatyrabota1-99999/call"]) {
    const r = await s.call("GET", path);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, `https://t.me/${path.split("/")[2]!.replace("-", "/")}`);
  }
  // «Не нашли» тоже помним сутки: повторные нажатия не дёргают t.me
  await s.call("GET", "/go/almatyrabota1-21300/wa");
  assert.equal(fetched.length, 2);
});

test("чужие адреса не открываем: только вакансии из каналов и только три вида связи", async () => {
  const { s, fetched } = await server();
  assert.equal((await s.call("GET", "/go/hh-139501020/wa")).status, 404);
  assert.equal((await s.call("GET", "/go/almatyrabota1-21258/sms")).status, 404);
  assert.equal((await s.call("GET", "/go/..%2F..%2Fetc-1/wa")).status, 404);
  assert.equal(fetched.length, 0);
});

test("текст отклика: название обрезается и чистится, без названия — общий текст", async () => {
  const { s } = await server();
  const text = async (t: string) =>
    new URL(String((await s.call("GET", "/go/almatyrabota1-21258/wa?t=" + encodeURIComponent(t))).headers.location)).searchParams.get("text");
  assert.equal(await text(""), "Здравствуйте! Пишу по вакансии. Нашёл её на vacante.kz");
  assert.equal(await text("Повар\n<script>"), "Здравствуйте! Пишу по вакансии «Повар script». Нашёл её на vacante.kz");
  assert.ok((await text("я".repeat(300)))!.length < 160);
});

test("нажатия считаются по дням, источникам и видам; видны в админке", async () => {
  const { s } = await server();
  await s.call("GET", "/go/almatyrabota1-21258/wa?s=web");
  await s.call("GET", "/go/almatyrabota1-21258/wa?s=web");
  await s.call("GET", "/go/almatyrabota1-21258/call?s=tg");
  await s.call("GET", "/go/almatyrabota1-21300/wa?s=%3Cscript%3E"); // метка не по формату, контакта нет
  const r = await s.call("GET", "/admin/funnel?days=7", { headers: admin });
  assert.deepEqual(r.json.clicks, [
    { day: "2026-11-04", source: "—", kind: "miss", n: 1 },
    { day: "2026-11-04", source: "tg", kind: "call", n: 1 },
    { day: "2026-11-04", source: "web", kind: "wa", n: 2 },
  ]);
});

test("много нажатий по новым вакансиям подряд: лишние идут на исходный пост, t.me не заваливаем", async () => {
  const pages: Record<string, string> = {};
  for (let i = 1; i <= 80; i++) pages[`almatyrabota1/${i}`] = embed("almatyrabota1", i, "Повар, тел 8 701 123 45 67");
  const { s, fetched } = await server(pages);
  let direct = 0;
  for (let i = 1; i <= 80; i++) {
    const r = await s.call("GET", `/go/almatyrabota1-${i}/wa`);
    if (String(r.headers.location).startsWith("https://wa.me/")) direct++;
  }
  assert.equal(fetched.length, 60);
  assert.equal(direct, 60);
});

test("фоновый сбор сохраняет номера всех вакансий из каналов, по порции за раз", async () => {
  const pages: Record<string, string> = {};
  for (let i = 1; i <= 5; i++) pages[`almatyrabota1/${i}`] = embed("almatyrabota1", i, `Повар, тел 8 701 123 45 6${i}`);
  const { s, fetched, fetchImpl } = await server(pages);
  s.db.prepare("INSERT INTO employers (id, key, name, first_seen, last_seen) VALUES (1, 'зерно', 'Зерно', '2026-11-01', '2026-11-04')").run();
  s.db.prepare("INSERT INTO venues (id, key, employer_id, name, first_seen, last_seen) VALUES (1, 'almaty:зерно', 1, 'Зерно', '2026-11-01', '2026-11-04')").run();
  const add = s.db.prepare(
    "INSERT INTO employer_vacancies (id, venue_id, title, source, posted_at, first_seen, last_seen, active) VALUES (?, 1, 'Повар', ?, '2026-11-04', '2026-11-04', '2026-11-04', ?)",
  );
  for (let i = 1; i <= 5; i++) add.run(`almatyrabota1-${i}`, "telegram", 1);
  add.run("hh-1", "hh", 1);
  add.run("almatyrabota1-77", "telegram", 0); // снята с сайта
  const deps = { db: s.db, fetch: fetchImpl, now: () => Date.parse("2026-11-04T06:00:00Z") };
  assert.equal(await backfillContacts(deps, 3, 0), 3);
  assert.equal(await backfillContacts(deps, 3, 0), 2);
  assert.equal(await backfillContacts(deps, 3, 0), 0);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM vacancy_contacts WHERE found = 1"), 5);
  assert.equal(fetched.length, 5);
});

test("вилка зарплаты «237000 - 237000 ₸» — не номер работодателя", async () => {
  const { contactsOf } = await import("../src/contacts.ts");
  assert.equal(contactsOf("Повар в кафе\nЗарплата: 237000 - 237000 ₸", [], "almaty_jobs").phone, null);
  assert.equal(contactsOf("Зарплата: 700000 - 700000 ₸\nТел: 87011234567", [], "almaty_jobs").phone, "+77011234567");
});

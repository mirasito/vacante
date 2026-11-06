import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { internalKey } from "../src/telegram.ts";
import { readFileSync } from "node:fs";

import { startServer, TOKEN } from "./helpers.ts";

const PASSWORD = "секрет-админки";
// Так же ключ считают админка в браузере, воркер бота и выкладка (server.yml)
const KEY = createHash("sha256").update("crm:" + PASSWORD.normalize("NFKC")).digest("hex");
const internal = { authorization: `Bearer ${internalKey(TOKEN)}` };
const admin = { authorization: `Bearer ${KEY}`, origin: "https://vacante.kz" };

const vacancy = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: "Бариста", category: "horeca", salary: "250 000 ₸/мес", source: "hh", posted_at: "2026-11-05T10:00:00+00:00",
  ...extra,
});

const greenwich = (vacancies: Record<string, unknown[]>) => ({
  key: "greenwich",
  name: "Greenwich",
  venues: [
    { key: "almaty:greenwich", name: "Greenwich", city: "almaty", address: "пр. Достык, 111", lat: 43.23, lon: 76.95,
      instagram: "greenwich.kz", avatar: "0123456789abcdef.jpg", twogis: "https://2gis.kz/almaty/search/Greenwich",
      agent_status: "found", vacancies: vacancies.almaty ?? [] },
    { key: "astana:greenwich", name: "Greenwich", city: "astana", vacancies: vacancies.astana ?? [] },
  ],
});

test("CRM: снимок с GitHub раскладывается по работодателям и заведениям, снятые вакансии уходят в архив", async () => {
  const s = await startServer({}, { CRM_KEY: KEY });
  try {
    const first = await s.call("POST", "/internal/crm/import", {
      headers: internal,
      body: { run_at: "2026-11-06T10:00:00Z", employers: [greenwich({ almaty: [vacancy("hh-1"), vacancy("tg-2", { source: "telegram" })], astana: [vacancy("bot-3", { source: "bot" })] })] },
    });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, { employers: 1, venues: 2, vacancies: 3 });
    let done = await s.call("POST", "/internal/crm/finish", { headers: internal, body: { run_at: "2026-11-06T10:00:00Z" } });
    assert.deepEqual(done.json, { archived: 0, employers: 1, venues: 2, active: 3, hh_missing: [] });

    // Через час tg-2 сняли с сайта: в снимке его нет
    await s.call("POST", "/internal/crm/import", {
      headers: internal,
      body: { run_at: "2026-11-06T11:00:00Z", employers: [greenwich({ almaty: [vacancy("hh-1")], astana: [vacancy("bot-3", { source: "bot" })] })] },
    });
    done = await s.call("POST", "/internal/crm/finish", { headers: internal, body: { run_at: "2026-11-06T11:00:00Z" } });
    assert.equal((done.json as { archived: number }).archived, 1);

    const list = await s.call("GET", "/admin/crm", { headers: admin });
    assert.equal(list.status, 200);
    assert.equal(list.headers["access-control-allow-origin"], "https://vacante.kz");
    const row = (list.json as { employers: Record<string, unknown>[] }).employers[0]!;
    assert.equal(row.name, "Greenwich");
    assert.equal(row.venues, 2);
    assert.equal(row.active, 2);
    assert.equal(row.total, 3);
    assert.deepEqual([...(row.cities as string[])].sort(), ["almaty", "astana"]);
    assert.equal(row.instagram, "greenwich.kz");

    const card = await s.call("GET", `/admin/crm/${row.id}`, { headers: admin });
    assert.equal(card.status, 200);
    const { employer, venues } = card.json as { employer: { name: string }; venues: Record<string, unknown>[] };
    assert.equal(employer.name, "Greenwich");
    const almaty = venues.find((v) => v.city === "almaty")!;
    assert.equal(almaty.address, "пр. Достык, 111");
    assert.deepEqual((almaty.vacancies as { id: string }[]).map((v) => v.id), ["hh-1"]);
    assert.deepEqual((almaty.archive as { id: string }[]).map((v) => v.id), ["tg-2"]);
    assert.equal(almaty.archived, 1);
  } finally {
    await s.close();
  }
});

test("CRM: без ключа ни импорта, ни просмотра; мусор в снимке отбрасывается", async () => {
  const s = await startServer({}, { CRM_KEY: KEY });
  try {
    assert.equal((await s.call("POST", "/internal/crm/import", { body: { run_at: "2026-11-06T10:00:00Z", employers: [] } })).status, 403);
    assert.equal((await s.call("GET", "/admin/crm", { headers: { authorization: `Bearer ${internalKey(TOKEN)}` } })).status, 403);
    assert.equal((await s.call("GET", "/admin/crm")).status, 403);
    assert.equal((await s.call("POST", "/internal/crm/import", { headers: internal, body: { employers: [] } })).status, 400);

    const r = await s.call("POST", "/internal/crm/import", {
      headers: internal,
      body: {
        run_at: "2026-11-06T10:00:00Z",
        employers: [
          { key: "", name: "Без ключа", venues: [{ key: "almaty:x", name: "X", vacancies: [] }] },
          { key: "cafe", name: "Кафе", venues: [] },
          { key: "dino", name: "DINO FEST", venues: [{ key: "almaty:dino", name: "DINO FEST", website: "javascript:alert(1) x", avatar: "../x.jpg",
            vacancies: [vacancy("v1", { source: "evil" }), vacancy("v2", { posted_at: "вчера" }), vacancy("v3")] }] },
        ],
      },
    });
    assert.deepEqual(r.json, { employers: 1, venues: 1, vacancies: 1 });
    const venue = s.db.prepare("SELECT website, avatar FROM venues WHERE key = 'almaty:dino'").get() as Record<string, unknown>;
    assert.equal(venue.website, null);
    assert.equal(venue.avatar, null);
  } finally {
    await s.close();
  }
});

test("CRM: без секрета ADMIN_PASSWORD админка получает понятную ошибку", async () => {
  const s = await startServer();
  try {
    const r = await s.call("GET", "/admin/crm", { headers: admin });
    assert.equal(r.status, 503);
  } finally {
    await s.close();
  }
});

const RUN = (hour: number) => `2026-11-06T${String(hour).padStart(2, "0")}:00:00Z`;

async function seed(s: Awaited<ReturnType<typeof startServer>>, hour = 10, extra: Record<string, unknown> = {}) {
  await s.call("POST", "/internal/crm/import", {
    headers: internal,
    body: {
      run_at: RUN(hour),
      employers: [
        { ...greenwich({ almaty: [vacancy("hh-1")], astana: [vacancy("bot-7", { source: "bot" })] }), hh_id: "555" },
        { key: "гринвич", name: "Гринвич", venues: [{ key: "almaty:гринвич", name: "Гринвич", city: "almaty", vacancies: [vacancy("tg-9", { source: "telegram" })] }] },
        { key: "cafe nova", name: "Cafe Nova", venues: [{ key: "almaty:cafe nova", name: "Cafe Nova", city: "almaty", vacancies: [vacancy("bot-8", { source: "bot" })] }] },
      ],
    },
  });
  return s.call("POST", "/internal/crm/finish", { headers: internal, body: { run_at: RUN(hour), ...extra } });
}
const idOf = (s: Awaited<ReturnType<typeof startServer>>, key: string) =>
  (s.db.prepare("SELECT id FROM employers WHERE key = ?").get(key) as { id: number }).id;

test("CRM: правки руками переживают импорт, склейка ведёт старое название к новому работодателю", async () => {
  const s = await startServer({}, { CRM_KEY: KEY });
  try {
    await seed(s);
    const g = idOf(s, "greenwich"), r = idOf(s, "гринвич");
    let res = await s.call("PATCH", `/admin/crm/${g}`, { headers: admin, body: { name: "Greenwich Coffee", bin: "123456789012", status: "sent", next_at: "2026-11-10", note: "Позвонить HR" } });
    assert.equal(res.status, 200);
    assert.equal((await s.call("PATCH", `/admin/crm/${g}`, { headers: admin, body: { bin: "12" } })).status, 400);
    res = await s.call("POST", `/admin/crm/${r}/merge`, { headers: admin, body: { into: g } });
    assert.equal(res.status, 200);
    const card = res.json as { employer: Record<string, unknown>; venues: { key: string; id: number }[]; activities: { kind: string }[] };
    assert.equal(card.employer.name, "Greenwich Coffee");
    assert.equal(card.employer.status, "sent");
    assert.equal(card.venues.length, 3);
    assert.ok(card.activities.some((a) => a.kind === "merge") && card.activities.some((a) => a.kind === "status"));
    // Следующий час: «Гринвич» снова в снимке, но попадает к Greenwich, а имя из правки остаётся
    await seed(s, 11);
    assert.equal(s.db.prepare("SELECT count(*) AS n FROM employers WHERE key = 'гринвич'").get()!.n, 0);
    const after = (await s.call("GET", `/admin/crm/${g}`, { headers: admin })).json as typeof card;
    assert.equal(after.employer.name, "Greenwich Coffee");
    assert.equal(after.venues.length, 3);
    // Правка заведения тоже не теряется
    const almaty = after.venues.find((v) => v.key === "almaty:greenwich")!;
    await s.call("PATCH", `/admin/crm/venues/${almaty.id}`, { headers: admin, body: { address: "пр. Достык, 117" } });
    await seed(s, 12);
    const v = (await s.call("GET", `/admin/crm/${g}`, { headers: admin })).json as { venues: { key: string; address: string }[] };
    assert.equal(v.venues.find((x) => x.key === "almaty:greenwich")!.address, "пр. Достык, 117");
  } finally {
    await s.close();
  }
});

test("CRM: новое заведение, перенос, фото и история из админки", async () => {
  const s = await startServer({}, { CRM_KEY: KEY });
  try {
    await seed(s);
    const g = idOf(s, "greenwich"), n = idOf(s, "cafe nova");
    let res = await s.call("POST", `/admin/crm/${g}/venues`, { headers: admin, body: { name: "Greenwich Mega", city: "almaty", address: "ТРЦ Mega", instagram: "@greenwich.mega" } });
    const venue = (res.json as { venues: { name: string; id: number; instagram: string; added_by: string }[] }).venues.find((v) => v.name === "Greenwich Mega")!;
    assert.equal(venue.instagram, "greenwich.mega");
    assert.equal(venue.added_by, "admin");
    const jpeg = readFileSync(new URL("./fixtures/photo-exif.jpg", import.meta.url));
    res = await s.call("PUT", `/admin/crm/venues/${venue.id}/photo`, { headers: { ...admin, "content-type": "image/jpeg" }, body: jpeg });
    assert.equal(res.status, 200);
    const photo = (res.json as { venues: { id: number; photos: { url: string; id: number }[] }[] }).venues.find((v) => v.id === venue.id)!.photos[0]!;
    const file = photo.url.split("/").pop()!;
    const img = await s.call("GET", `/crm/media/${file}`);
    assert.equal(img.status, 200);
    assert.equal((await s.call("GET", "/crm/media/crm-nope.jpg")).status, 404);
    res = await s.call("PATCH", `/admin/crm/venues/${venue.id}`, { headers: admin, body: { employer_id: n } });
    assert.ok((res.json as { venues: { id: number }[] }).venues.some((v) => v.id === venue.id));
    res = await s.call("POST", `/admin/crm/${n}/activities`, { headers: admin, body: { kind: "call", text: "Позвонил, ждут прайс" } });
    assert.equal((res.json as { activities: { kind: string; text: string }[] }).activities[0]!.text, "Позвонил, ждут прайс");
    res = await s.call("DELETE", `/admin/crm/media/${photo.id}`, { headers: admin });
    assert.equal(res.status, 200);
    assert.equal((await s.call("GET", `/crm/media/${file}`)).status, 404);
  } finally {
    await s.close();
  }
});

test("CRM: вакансии и оплаты из бота, статусы старой CRM, данные hh", async () => {
  const s = await startServer({}, { CRM_KEY: KEY });
  try {
    const done = await seed(s, 10, {
      jobs: [
        { job_id: 7, chat: 111, name: "Айгерим @hr", venue_key: "astana:greenwich", employer_key: "greenwich" },
        { job_id: 8, chat: 222, name: "Ерлан", venue_key: "almaty:cafe nova", employer_key: "cafe nova" },
      ],
      payments: [
        { id: 1, job_id: 8, kind: "post", amount: 900, status: "confirmed", at: "2026-11-06T09:00:00Z" },
        { id: 2, job_id: 8, kind: "boost", amount: 2500, status: "pending", at: "2026-11-06T09:30:00Z" },
      ],
      marks: { "almaty:cafe nova": { status: "replied", note: "Ответили в Instagram" } },
    });
    assert.deepEqual((done.json as { hh_missing: string[] }).hh_missing, ["555"]);
    await s.idle();
    const g = idOf(s, "greenwich"), n = idOf(s, "cafe nova");
    // У Greenwich есть вакансии с hh: профиль только по заявке. Cafe Nova знают только по боту: профиль сразу
    const members = s.db.prepare("SELECT employer_id, tg_chat, confirmed_at FROM members ORDER BY tg_chat").all() as { employer_id: number; confirmed_at: string | null }[];
    assert.equal(members[0]!.employer_id, g);
    assert.equal(members[0]!.confirmed_at, null);
    assert.equal(members[1]!.employer_id, n);
    assert.ok(members[1]!.confirmed_at);
    assert.ok(s.sent.some((m) => m.method === "sendMessage" && m.body.chat_id === 222 && String(m.body.text).includes("профиль работодателя")));
    const list = (await s.call("GET", "/admin/crm", { headers: admin })).json as { employers: Record<string, unknown>[] };
    const nova = list.employers.find((e) => e.id === n)!;
    assert.equal(nova.paid, 900);
    assert.equal(nova.status, "replied");
    assert.equal(list.employers.find((e) => e.id === g)!.claims, 1);
    // Повтор того же снимка не дублирует ни профили, ни приветствия, ни записи об оплате
    const greetings = s.sent.length;
    await seed(s, 11, { jobs: [{ job_id: 8, chat: 222, venue_key: "almaty:cafe nova" }], payments: [{ id: 1, job_id: 8, kind: "post", amount: 900, status: "confirmed" }] });
    await s.idle();
    assert.equal(s.sent.length, greetings);
    const card = (await s.call("GET", `/admin/crm/${n}`, { headers: admin })).json as { activities: { kind: string }[]; payments: unknown[] };
    assert.equal(card.activities.filter((a) => a.kind === "payment").length, 1);
    assert.equal(card.payments.length, 2);
    const hh = await s.call("POST", "/internal/crm/hh", { headers: internal, body: { employers: [{ id: "555", logo: "https://img.hhcdn.ru/l.png", site: "https://greenwich.kz", about: "Сеть кофеен" }] } });
    assert.deepEqual(hh.json, { updated: 1 });
    const e = ((await s.call("GET", `/admin/crm/${g}`, { headers: admin })).json as { employer: { hh: Record<string, string> } }).employer;
    assert.equal(e.hh.about, "Сеть кофеен");
    // Подтверждение заявки: человеку приходит сообщение
    const claim = s.db.prepare("SELECT id FROM members WHERE employer_id = ?").get(g) as { id: number };
    await s.call("POST", `/admin/crm/members/${claim.id}`, { headers: admin, body: { action: "confirm" } });
    await s.idle();
    assert.ok(s.sent.some((m) => m.body.chat_id === 111 && String(m.body.text).includes("подтверждён")));
  } finally {
    await s.close();
  }
});

const update = (chat: number, text: string, replyTo?: string) => ({
  update_id: 1,
  message: { message_id: 5, chat: { id: chat, type: "private" }, from: { id: chat, first_name: "Айгерим", username: "hr" }, text, ...(replyTo ? { reply_to_message: { text: replyTo } } : {}) },
});
const press = (chat: number, data: string) => ({
  update_id: 2,
  callback_query: { id: "q1", from: { id: chat, first_name: "Айгерим", username: "hr" }, data, message: { message_id: 9, chat: { id: chat, type: "private" } } },
});

test("Бот /company: найти свою компанию, заявка, добавить заведение, выбрать заведение для вакансии", async () => {
  const s = await startServer({}, { CRM_KEY: KEY });
  try {
    await seed(s);
    const g = idOf(s, "greenwich");
    const tg = (body: unknown) => s.call("POST", "/internal/telegram", { headers: internal, body });
    let r = await tg(update(333, "/company"));
    assert.deepEqual(r.json, { ok: true, handled: true });
    assert.ok(String(s.sent.at(-1)!.body.text).startsWith("🔎 Поиск компании"));
    await tg(update(333, "greenwich", "🔎 Поиск компании\n…"));
    const kb = (s.sent.at(-1)!.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
    assert.equal(kb[0]![0]!.callback_data, `c:cl:${g}`);
    await tg(press(333, `c:cl:${g}`));
    assert.match(String(s.sent.at(-1)!.body.text), /Заявка отправлена/);
    // Без подтверждения добавить заведение нельзя
    await tg(press(333, `c:add:${g}`));
    assert.ok(!s.sent.at(-1)!.body.text || s.sent.at(-1)!.method === "answerCallbackQuery");
    assert.equal(s.db.prepare("SELECT count(*) AS n FROM crm_bot_state WHERE tg_chat = 333 AND employer_id IS NOT NULL").get()!.n, 0);
    const mid = (s.db.prepare("SELECT id FROM members WHERE tg_chat = 333").get() as { id: number }).id;
    await s.call("POST", `/admin/crm/members/${mid}`, { headers: admin, body: { action: "confirm" } });
    await tg(press(333, `c:add:${g}`));
    await tg(press(333, `c:ac:${g}:almaty`));
    assert.ok(String(s.sent.at(-1)!.body.text).startsWith("🏠 Новое заведение · Алматы"));
    await tg(update(333, "Greenwich Mega, ТРЦ Mega Alma-Ata, @greenwich.mega", "🏠 Новое заведение · Алматы"));
    const added = s.db.prepare("SELECT * FROM venues WHERE added_by = 'employer'").get() as Record<string, unknown>;
    assert.equal(added.name, "Greenwich Mega");
    assert.equal(added.address, "ТРЦ Mega Alma-Ata");
    assert.equal(added.instagram, "greenwich.mega");
    assert.equal(added.review, "pending");
    await s.call("PATCH", `/admin/crm/venues/${added.id}`, { headers: admin, body: { review: "approved" } });
    await s.idle();
    assert.ok(s.sent.some((m) => m.body.chat_id === 333 && String(m.body.text).includes("проверили")));
    // Вакансия из бота: у Greenwich теперь 3 заведения, спросим, для какого она
    await s.call("POST", "/internal/crm/finish", { headers: internal, body: { run_at: RUN(10), jobs: [{ job_id: 7, chat: 333, venue_key: "astana:greenwich" }] } });
    await s.idle();
    const question = s.sent.findLast((m) => String(m.body.text).startsWith("Вакансия №7"))!;
    const choice = (question.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard
      .flat().find((b) => b.callback_data.endsWith(`:${added.id}`))!;
    await tg(press(333, choice.callback_data));
    assert.equal((s.db.prepare("SELECT venue_id FROM employer_vacancies WHERE id = 'bot-7'").get() as { venue_id: number }).venue_id, added.id);
    // И следующий импорт оставляет вакансию в выбранном заведении
    await seed(s, 11);
    assert.equal((s.db.prepare("SELECT venue_id FROM employer_vacancies WHERE id = 'bot-7'").get() as { venue_id: number }).venue_id, added.id);
    // Чужой не может выбрать заведение за работодателя
    await tg(press(444, choice.callback_data));
    assert.equal(s.sent.at(-1)!.body.text, "Эта кнопка уже не работает");
  } finally {
    await s.close();
  }
});

test("Бот /company: новой компании нет в базе — создаём профиль сразу", async () => {
  const s = await startServer({}, { CRM_KEY: KEY });
  try {
    const tg = (body: unknown) => s.call("POST", "/internal/telegram", { headers: internal, body });
    await tg(update(555, "ТОО «Солнечный двор»", "🔎 Поиск компании"));
    await tg(press(555, "c:nw"));
    const e = s.db.prepare("SELECT e.id, e.name FROM employers e JOIN members m ON m.employer_id = e.id WHERE m.tg_chat = 555 AND m.confirmed_at IS NOT NULL").get() as { name: string };
    assert.equal(e.name, "ТОО «Солнечный двор»");
    assert.match(String(s.sent.at(-1)!.body.text), /Добавьте их/);
    // Сообщения не для CRM бот обрабатывает сам
    assert.deepEqual((await tg(update(555, "привет"))).json, { ok: true, handled: false });
  } finally {
    await s.close();
  }
});

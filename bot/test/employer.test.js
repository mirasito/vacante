import assert from "node:assert/strict";
import { test } from "node:test";

import * as job from "../src/employer.js";

const filled = { ...job.newJob(), id: 5, city: "astana", title: "Повар <горячий цех>", company: "Кафе", salary: "300 000 ₸" };

test("анкета идёт по порядку, необязательное пропускается", () => {
  let draft = { ...job.newJob(), step: "city" };
  assert.equal(job.nextStep(draft).field, "city");
  assert.equal(job.pressed(draft, "jobcity:atlantis"), null);
  draft = job.pressed(draft, "jobcity:astana");
  assert.equal(job.nextStep(draft).field, "title");
  assert.equal(job.pressed({ ...draft, step: "title" }, "skip:title"), null); // должность обязательна
  assert.equal(job.answer(draft, "title", "   ").error, "Напишите ответ текстом.");
  assert.match(job.answer(draft, "title", "я".repeat(81)).error, /81 символов/);
  draft = job.answer(draft, "title", "  Повар  ").job;
  assert.equal(draft.title, "Повар");
  const done = { ...filled, schedule: "", address: "", details: "" };
  assert.equal(job.nextStep(done), null);
  assert.deepEqual(job.pressed(done, "jobredo"), { ...done, ...job.newJob() });
});

test("карточка экранирует HTML и не показывает пустые поля", () => {
  const card = job.card({ ...filled, schedule: "", details: "" });
  assert.equal(card, "<b>Повар &lt;горячий цех&gt;</b>\n🏢 Кафе\n📍 Астана\n💰 <b>300 000 ₸</b>");
});

test("отклик: имя, телефон и ссылка на кандидата без @username", () => {
  const text = job.applicationText(filled, { id: 3, first_name: "Ерлан" }, "Опыт 2 года", "+77010000000");
  assert.match(text, /^📩 Отклик на «Повар &lt;горячий цех&gt;»\n\nОпыт 2 года\n\n👤 Ерлан, 📱 \+77010000000/);
  assert.match(text, /tg:\/\/user\?id=3/);
  assert.doesNotMatch(job.applicationText(filled, { id: 3, first_name: "Ерлан", username: "erlan" }, "Привет"), /tg:\/\//);
});

test("мои вакансии: закрыть можно только открытые", () => {
  const screen = job.myJobsScreen([
    { ...filled, status: "approved", applications: 2 },
    { ...filled, id: 4, status: "rejected", applications: 0 },
  ]);
  assert.match(screen.text, /№5 <b>Повар &lt;горячий цех&gt;<\/b>, Астана: опубликована, откликов: 2/);
  assert.match(screen.text, /№4 .*: отклонена$/m);
  assert.deepEqual(screen.keyboard.map((row) => row[0].callback_data), ["close:5"]);
  assert.match(job.myJobsScreen([]).text, /пока нет вакансий/);
});

test("«Срочно»: условия из настроек, дата по Казахстану, пост в канале только для Астаны и Алматы", () => {
  assert.equal(job.boostOffer({}), null);
  assert.deepEqual(job.boostOffer({ KASPI_DETAILS: " +7 700 ", BOOST_PRICE: "5000", BOOST_DAYS: "3" }), { price: 5000, days: 3, kaspi: "+7 700", shiftPrice: 1000 });
  assert.equal(job.localDate("2026-11-05 20:00:00"), "06.11");
  const now = new Date("2026-11-01T00:00:00Z");
  assert.ok(job.isBoosted({ boost_until: "2026-11-01 00:00:01" }, now));
  assert.ok(!job.isBoosted({ boost_until: "2026-10-31 23:59:59" }, now));
  assert.ok(!job.isBoosted({ boost_until: null }, now));
  const boost = { price: 3000, days: 7, kaspi: "+7 700 <Мирас>" };
  assert.match(job.boostScreen(filled, boost).text, /в нашем канале Астана/);
  assert.match(job.boostScreen(filled, boost).text, /\+7 700 &lt;Мирас&gt;/);
  assert.doesNotMatch(job.boostScreen({ ...filled, city: "shymkent" }, boost).text, /канале/);
});

test("«Срочно» для смены: дешевле и до дня смены", () => {
  const boost = job.boostOffer({ KASPI_DETAILS: "Kaspi 8 777 000 00 00, Мирас" });
  const now = new Date("2026-11-06T07:00:00Z");
  const s = { ...filled, kind: "shift", shift_date: "2026-11-08", shift_start: "10:00", shift_end: "22:00", need: 2, status: "approved" };
  assert.deepEqual([job.offerFor(boost, s, now).price, job.offerFor(boost, s, now).days], [1000, 3]);
  assert.equal(job.offerFor(boost, filled, now).price, 3000);
  assert.match(job.boostScreen(s, boost, now).text, /до начала смены за 1 000 ₸/);
  assert.match(job.approvedScreen(s, boost, now).text, /Смена прошла проверку/);
  assert.match(job.myJobsScreen([{ ...s, applications: 3, confirmed: 1 }], boost, now).text, /⚡ <b>Повар &lt;горячий цех&gt;<\/b>, Астана 08\.11: опубликована, взяли 1 из 2, просились: 3/);
});

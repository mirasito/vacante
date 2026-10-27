import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import * as bot from "../src/logic.js";

const press = (sub, ...steps) => steps.reduce((s, data) => bot.press(s, data).sub, sub);

test("настройка подписки: город, сферы, условия, зарплата", () => {
  let sub = press(bot.newSubscription(), "city:almaty", "cat:horeca", "cat:retail", "cat:horeca", "perk:0", "perk:salary");
  sub = press(sub, "pay", "pay");
  assert.equal(sub.city, "almaty");
  assert.deepEqual(sub.categories, ["retail"]);
  assert.deepEqual(sub.perks, ["Без опыта", "salary"]);
  assert.equal(sub.min_pay, 300000);
  assert.equal(press(sub, "pay", "pay").min_pay, 0); // по кругу: 400 000, потом любая
  assert.equal(bot.press(sub, "done").show, "done");
  assert.equal(press(sub, "done").active, 1);
  assert.equal(press(sub, "done", "stop").active, 0);
  assert.equal(press(sub, "city:all").city, null);
  assert.equal(press(sub, "city:moscow").city, "almaty"); // незнакомое не принимаем
});

test("сохранение в строку базы и обратно", () => {
  const sub = press(bot.newSubscription(), "city:astana", "cat:delivery", "perk:4", "done");
  const [city, categories, perks, minPay, active] = bot.toRow(sub);
  assert.deepEqual(bot.fromRow({ city, categories, perks, min_pay: minPay, active }), sub);
  assert.deepEqual(bot.fromRow(null), bot.newSubscription());
});

test("экраны отмечают выбранное", () => {
  const sub = press(bot.newSubscription(), "city:astana", "cat:horeca", "perk:salary");
  assert.ok(bot.screen("city", sub).keyboard.flat().some((b) => b.text === "✅ Астана"));
  assert.ok(bot.screen("cats", sub).keyboard.flat().some((b) => b.text === "✅ Кафе и рестораны"));
  assert.ok(bot.screen("perks", sub).keyboard.flat().some((b) => b.text === "✅ С зарплатой"));
  for (const name of ["city", "cats", "perks", "done"]) {
    for (const b of bot.screen(name, sub).keyboard.flat()) {
      assert.ok(Buffer.byteLength(b.callback_data || "") <= 64, b.callback_data);
    }
  }
  assert.equal(
    bot.summary(press(sub, "perk:0", "pay")),
    "Астана · Кафе и рестораны · с зарплатой · без опыта · от 200 000 ₸ в месяц",
  );
  assert.equal(bot.summary(bot.newSubscription()), "весь Казахстан · любая сфера");
});

test("подбор вакансий из feed.json", () => {
  const feed = [
    { id: "a", city: "almaty", category: "horeca", perks: ["Без опыта"], pay: 264000, html: "<b>Бариста</b>" },
    { id: "b", city: "almaty", category: "retail", perks: [], pay: 0, html: "<b>Продавец</b>" },
    { id: "c", city: "astana", category: "horeca", perks: [], pay: 400000, html: "<b>Повар</b>" },
  ];
  const sub = press(bot.newSubscription(), "city:almaty");
  assert.deepEqual(feed.filter((v) => bot.matches(sub, v)).map((v) => v.id), ["a", "b"]);
  assert.deepEqual(feed.filter((v) => bot.matches(press(sub, "perk:salary"), v)).map((v) => v.id), ["a"]);
  assert.deepEqual(feed.filter((v) => bot.matches(press(sub, "pay", "pay"), v)).map((v) => v.id), []);
  assert.equal(bot.examples(press(sub, "cat:horeca"), feed), "Вот последние подходящие:\n\n<b>Бариста</b>");
  assert.match(bot.examples(press(sub, "perk:3"), feed), /подходящих вакансий нет/);
});

test("секрет вебхука совпадает с тем, что ставит workflow", async () => {
  const token = "123:abc";
  const expected = createHash("sha256").update(token).digest("hex").slice(0, 32);
  assert.equal(await bot.webhookSecret(token), expected);
});

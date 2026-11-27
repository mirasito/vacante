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
  // Несколько условий — любое из них: «Без опыта» или «Жильё» находит бариста без опыта
  const both = { ...sub, perks: ["Без опыта", "Жильё"] };
  assert.deepEqual(feed.filter((v) => bot.matches(both, v)).map((v) => v.id), ["a"]);
  assert.deepEqual(feed.filter((v) => bot.matches({ ...both, perks: ["Жильё", "Питание"] }, v)).map((v) => v.id), []);
});

test("секрет вебхука совпадает с тем, что ставит workflow", async () => {
  const token = "123:abc";
  const expected = createHash("sha256").update(token).digest("hex").slice(0, 32);
  assert.equal(await bot.webhookSecret(token), expected);
});

test("подписка по ссылке из приложения", () => {
  assert.deepEqual(bot.fromLink("sub_almaty_horeca_250000"), {
    city: "almaty", categories: ["horeca"], perks: [], min_pay: 250000, active: 1,
  });
  assert.deepEqual(bot.fromLink("sub_astana_all_0").categories, []);
  assert.equal(bot.fromLink("sub_mars_all_0"), null);
  assert.equal(bot.fromLink("sub_almaty_nope_0"), null);
  assert.equal(bot.fromLink("apply_5"), null);
  assert.deepEqual(bot.fromLink("sub_almaty_all_0_s").perks, ["Смены и подработка"]);
});

test("на экране сфер можно закончить сразу: «Готово», условия по отдельной кнопке", () => {
  const sub = press(bot.newSubscription(), "city:almaty");
  assert.deepEqual(bot.screen("cats", sub).keyboard.slice(-2), [
    [{ text: "← Город", callback_data: "go:city" }, { text: "Условия и зарплата →", callback_data: "go:perks" }],
    [{ text: "Готово ✅", callback_data: "done" }],
  ]);
  // «Готово» сразу после города: подписка на все сферы этого города
  assert.deepEqual(bot.press(sub, "done"), {
    sub: { city: "almaty", categories: [], perks: [], min_pay: 0, active: 1, setup: "done" },
    show: "done",
  });
  // Старые клавиатуры в чатах работают: «Дальше →» вело на условия тем же нажатием, «Готово» там осталось
  assert.equal(bot.press(sub, "go:perks").show, "perks");
  assert.deepEqual(bot.screen("perks", sub).keyboard.at(-1).map((b) => b.callback_data), ["go:cats", "done"]);
});

test("шаг настройки подписки: каждое нажатие с каждого шага", () => {
  const buttons = ["go:city", "go:cats", "go:perks", "city:almaty", "cat:horeca", "perk:0", "pay", "done", "stop"];
  // Просмотр экранов (go:) запоминает самый дальний и не трогает итог. Выбор после «Готово» или остановки начинает заново
  const after = [
    [null, ["city", "cats", "perks", "cats", "cats", "perks", "perks", "done", "stopped"]],
    ["city", ["city", "cats", "perks", "cats", "cats", "perks", "perks", "done", "stopped"]],
    ["cats", ["cats", "cats", "perks", "cats", "cats", "perks", "perks", "done", "stopped"]],
    ["perks", ["perks", "perks", "perks", "perks", "perks", "perks", "perks", "done", "stopped"]],
    ["done", ["done", "done", "done", "cats", "cats", "perks", "perks", "done", "stopped"]],
    ["stopped", ["stopped", "stopped", "stopped", "cats", "cats", "perks", "perks", "done", "stopped"]],
  ];
  for (const [setup, expected] of after) {
    const sub = { ...bot.newSubscription(), setup };
    assert.deepEqual(buttons.map((data) => bot.press(sub, data).sub.setup), expected, `с шага ${setup}`);
  }
  assert.equal(bot.newSubscription().setup, null); // только /start
  assert.equal(press(bot.newSubscription(), "city:all").setup, "cats"); // «Весь Казахстан» тоже выбор
  assert.equal(press(bot.newSubscription(), "незнакомая кнопка").setup, "city"); // показывает вопрос о городе

  // Включает и выключает подписку только «Готово» и «Остановить»: правка включённой её не останавливает
  const active = press(bot.newSubscription(), "city:almaty", "done");
  for (const data of buttons.slice(0, 7)) assert.equal(bot.press(active, data).sub.active, 1, data);
  for (const data of buttons.slice(0, 7)) assert.equal(bot.press(press(active, "stop"), data).sub.active, 0, data);

  // Вопрос о городе не с экрана настройки: «🔔 Присылать вакансии» и /settings его только показывают,
  // а /smeny без города ещё и добавляет условие «Смены и подработка», это выбор
  assert.deepEqual([null, "city", "cats", "perks", "done", "stopped"].map((setup) => bot.reached(setup, "city")),
    ["city", "city", "cats", "perks", "done", "stopped"]);
  assert.deepEqual([null, "city", "cats", "perks", "done", "stopped"].map((setup) => bot.reached(setup, "city", true)),
    ["city", "city", "cats", "perks", "city", "city"]);
});

test("шаг настройки в строке базы: у активной строки до миграции «Готово» уже было", () => {
  assert.equal(bot.toRow(press(bot.newSubscription(), "city:almaty")).at(-1), "cats");
  assert.equal(bot.toRow(bot.fromLink("sub_almaty_all_0")).at(-1), null); // «Готово» ссылке ставит index.js
  assert.equal(bot.fromRow({ city: "almaty", active: 0, setup: "perks" }).setup, "perks");
  assert.equal(bot.fromRow({ city: "almaty", active: 1, setup: "cats" }).setup, "cats");
  assert.equal(bot.fromRow({ city: "almaty", active: 1, setup: null }).setup, "done");
  assert.equal(bot.fromRow({ city: "almaty", active: 0, setup: null }).setup, null);
});

test("напоминание о незаконченной подписке: без города вопрос ещё раз, с городом «Включить»", () => {
  const asked = { ...bot.newSubscription(), setup: "city" };
  assert.deepEqual(bot.nudgeScreen(asked), {
    text: "Вы просили присылать вакансии, но не выбрали город, поэтому я пока ничего не присылаю.\n\nГде ищете работу?",
    keyboard: bot.screen("city", asked).keyboard,
  });
  const unfinished = "Вы просили присылать вакансии, но не закончили настройку, поэтому я пока ничего не присылаю.\n\n";
  const keyboard = [
    [{ text: "✅ Включить", callback_data: "done" }],
    [{ text: "⚙️ Настроить", callback_data: "go:city" }, { text: "Не нужно", callback_data: "stop" }],
  ];
  const chosen = press(bot.newSubscription(), "city:astana", "cat:horeca");
  assert.deepEqual(bot.nudgeScreen(chosen), {
    text: `${unfinished}Могу присылать новые вакансии: Астана · Кафе и рестораны. Включить?`,
    keyboard,
  });
  // Строка до миграции с уже выбранным городом снова открыла вопрос о городе: напоминание не говорит, что города нет
  const reopened = { ...bot.newSubscription(), city: "astana", categories: ["horeca"], setup: "city" };
  assert.deepEqual(bot.nudgeScreen(reopened), {
    text: `${unfinished}Могу присылать новые вакансии: Астана · Кафе и рестораны. Включить?`,
    keyboard,
  });
  const everywhere = press(bot.newSubscription(), "city:all", "go:perks", "perk:salary", "pay");
  assert.equal(everywhere.setup, "perks");
  assert.deepEqual(bot.nudgeScreen(everywhere), {
    text: `${unfinished}Могу присылать новые вакансии: весь Казахстан · любая сфера · с зарплатой · от 200 000 ₸ в месяц. Включить?`,
    keyboard,
  });
  // Кнопки делают то, что на них написано: включает только «Включить»
  assert.deepEqual([bot.press(chosen, "done").sub.active, bot.press(chosen, "done").show], [1, "done"]);
  assert.deepEqual([bot.press(chosen, "go:city").sub.active, bot.press(chosen, "go:city").show], [0, "city"]);
  assert.deepEqual([bot.press(chosen, "stop").sub.active, bot.press(chosen, "stop").show], [0, "stopped"]);
});

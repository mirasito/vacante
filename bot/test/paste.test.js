import assert from "node:assert/strict";
import { test } from "node:test";

import { findCity, fromHh, looksPasted, parseVacancy, pasteUrl } from "../src/paste.js";

test("объявление из канала раскладывается по вопросам анкеты", () => {
  const got = parseVacancy(`🔥🔥 СРОЧНО!
Требуется официант в кафе «Зерно»
Зарплата: 12 000 тг за смену + чаевые
График: 2/2 с 10:00 до 22:00
Адрес: ул. Кабанбай батыра 15, Астана
Питание, развозка после 22:00.
Звонить: +7 701 123 45 67, @zerno_hr`);
  assert.equal(got.title, "Официант");
  assert.equal(got.company, "кафе «Зерно»");
  assert.equal(got.salary, "12 000 тг за смену + чаевые");
  assert.equal(got.schedule, "2/2 с 10:00 до 22:00");
  assert.equal(got.address, "ул. Кабанбай батыра 15, Астана");
  assert.equal(got.city, "astana");
  assert.doesNotMatch(got.details, /701|@zerno_hr/);
  assert.match(got.details, /Питание, развозка/);
});

test("без подписей: должность первой строкой, деньги и график по виду", () => {
  const got = parseVacancy("Бариста\nКофейня в центре Алматы\n250 000 ₸ в месяц\n5/2, с 8 до 17");
  assert.deepEqual([got.title, got.salary, got.schedule, got.city], ["Бариста", "250 000 ₸ в месяц", "5/2, с 8 до 17", "almaty"]);
  assert.equal(got.company, undefined);
});

test("город словами, ссылки и что считать вставкой", () => {
  assert.equal(findCity("в Караганде"), "karaganda");
  assert.equal(findCity("Өскемен"), "ust-kamenogorsk");
  assert.equal(findCity("Москва"), null);
  assert.deepEqual(pasteUrl("https://almaty.hh.kz/vacancy/123456?from=share"), { kind: "hh", id: "123456" });
  assert.deepEqual(pasteUrl("смотрите t.me/rabota_almaty/31975"), { kind: "tg", channel: "rabota_almaty", post: "31975" });
  assert.deepEqual(pasteUrl("https://www.olx.kz/d/obyavlenie/x"), { kind: "other" });
  assert.equal(looksPasted("Официант"), false);
  assert.equal(looksPasted("https://hh.kz/vacancy/1"), true);
  assert.equal(looksPasted("Повар\nот 300 000\nАлматы"), true);
});

test("вакансия из API hh", () => {
  const got = fromHh({
    name: "Продавец-консультант", employer: { name: "ТОО Магнум" }, area: { name: "Алматы" },
    salary: { from: 250000, to: 300000, currency: "KZT" }, schedule: { name: "Сменный график" },
    address: { raw: "Алматы, проспект Абая, 10" }, description: "<p>Работа в зале.</p><ul><li>Питание</li></ul>",
  });
  assert.deepEqual(got, {
    title: "Продавец-консультант", company: "ТОО Магнум", salary: "250 000–300 000 ₸ в месяц", schedule: "Сменный график",
    address: "Алматы, проспект Абая, 10", city: "almaty", details: "Работа в зале.\n• Питание",
  });
});

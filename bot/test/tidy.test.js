import assert from "node:assert/strict";
import { test } from "node:test";

import { tidyAddress, tidyCompany, tidyDetails, tidyJob, tidySalary, tidySchedule, tidyTitle } from "../src/tidy.js";

test("должность и название: без капса, «Требуется» и «!!!», кавычки-ёлочки", () => {
  assert.equal(tidyTitle("ТРЕБУЕТСЯ ОФИЦИАНТ!!!"), "Официант");
  assert.equal(tidyTitle("Срочно нужен грузчик"), "Грузчик");
  assert.equal(tidyTitle("Повар, помощник повара"), "Повар, помощник повара");
  assert.equal(tidyCompany("кафе \"Зерно\""), "Кафе «Зерно»");
  assert.equal(tidyCompany("KFC"), "KFC");
});

test("зарплата: тысячи пробелами, ₸, вилки и «тыс»", () => {
  assert.equal(tidySalary("250000тг"), "250 000 ₸");
  assert.equal(tidySalary("200-300 тыс"), "200 000–300 000 ₸");
  assert.equal(tidySalary("150.000-200.000 тг"), "150 000–200 000 ₸");
  assert.equal(tidySalary("от 150к + бонусы"), "от 150 000 ₸ + бонусы");
  assert.equal(tidySalary("15000 за смену"), "15 000 ₸ за смену");
  assert.equal(tidySalary("12 000 ₸ за смену"), "12 000 ₸ за смену");
  assert.equal(tidySalary("по договорённости"), "По договорённости");
  assert.equal(tidySalary("2,5 тыс за час"), "2 500 ₸ за час");
  assert.equal(tidySalary("1.5-2 тыс в час"), "1 500–2 000 ₸ в час");
});

test("график и адрес: 09:00–18:00, ул. Сункар, 39", () => {
  assert.equal(tidySchedule("с 9 до 18, 5/2"), "09:00–18:00, 5/2");
  assert.equal(tidySchedule("2 на 2 9.00-21.00"), "2/2 09:00–21:00");
  assert.equal(tidyAddress("ул сункар 39"), "ул. Сункар, 39");
  assert.equal(tidyAddress("ТРЦ Mega, пр. Абая"), "ТРЦ Mega, пр. Абая");
});

test("описание: пункты списка, пустые строки, капс; tidyJob говорит, что поменял", () => {
  assert.equal(tidyDetails("ОБЯЗАННОСТИ:\n- обслуживание гостей\n- работа с кассой!!!\n\n\n\nусловия :питание,развозка"),
    "Обязанности:\n• обслуживание гостей\n• работа с кассой!\n\nУсловия: питание, развозка");
  const { job, changed } = tidyJob({ kind: "shift", title: "повар", schedule: "Смена 07.11, 10:00–22:00", salary: "15000тг", address: "" });
  assert.deepEqual(changed, ["title", "salary"]);  // график смены бот собирает сам
  assert.equal(job.schedule, "Смена 07.11, 10:00–22:00");
});

// Логика бота без сети и базы: экраны настройки подписки, разбор нажатий, подбор вакансий.
// Списки городов, сфер и условий лежат в options.json; тест на Python сверяет их с сайтом.
import options from "./options.json" with { type: "json" };

export const SALARY = "salary"; // условие «С зарплатой», как в vacante/digest.py
const CITY = Object.fromEntries(options.cities);
const CATEGORY = Object.fromEntries(options.categories);

export function newSubscription() {
  return { city: null, categories: [], perks: [], min_pay: 0, active: 0 };
}

export function fromRow(row) {
  if (!row) return newSubscription();
  return {
    city: row.city || null,
    categories: row.categories ? row.categories.split(",") : [],
    perks: row.perks ? row.perks.split("|") : [],
    min_pay: Number(row.min_pay) || 0,
    active: Number(row.active) || 0,
  };
}

export function toRow(sub) {
  return [sub.city, sub.categories.join(","), sub.perks.join("|"), sub.min_pay, sub.active];
}

export function money(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function toggle(list, item) {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

function rows(buttons, perRow) {
  const out = [];
  for (let i = 0; i < buttons.length; i += perRow) out.push(buttons.slice(i, i + perRow));
  return out;
}

const mark = (on, text) => (on ? `✅ ${text}` : text);

export function summary(sub) {
  const parts = [sub.city ? CITY[sub.city] : "весь Казахстан"];
  parts.push(sub.categories.length ? sub.categories.map((c) => CATEGORY[c]).join(", ") : "любая сфера");
  for (const p of sub.perks) parts.push(p === SALARY ? "с зарплатой" : p.toLowerCase());
  if (sub.min_pay) parts.push(`от ${money(sub.min_pay)} ₸ в месяц`);
  return parts.join(" · ");
}

export function screen(name, sub) {
  if (name === "city") {
    const cities = options.cities.map(([slug, title]) => ({ text: mark(sub.city === slug, title), callback_data: `city:${slug}` }));
    return {
      text: "Где ищете работу?",
      keyboard: [...rows(cities, 3), [{ text: mark(sub.city === null && sub.active, "Весь Казахстан"), callback_data: "city:all" }]],
    };
  }
  if (name === "cats") {
    const cats = options.categories.map(([slug, title]) => ({ text: mark(sub.categories.includes(slug), title), callback_data: `cat:${slug}` }));
    return {
      text: "Какая работа интересна? Можно выбрать несколько. Если ничего не выбрать, пришлю все сферы.",
      keyboard: [...rows(cats, 2), [{ text: "← Город", callback_data: "go:city" }, { text: "Дальше →", callback_data: "go:perks" }]],
    };
  }
  if (name === "perks") {
    const perks = [[SALARY, "С зарплатой"], ...options.perks.map((p, i) => [String(i), p])].map(([key, title]) => {
      const value = key === SALARY ? SALARY : options.perks[Number(key)];
      return { text: mark(sub.perks.includes(value), title), callback_data: `perk:${key}` };
    });
    const pay = sub.min_pay ? `от ${money(sub.min_pay)} ₸` : "любая";
    return {
      text: "Что для вас важно? Это можно пропустить.\nЗарплату за смену и за час считаю как полный месяц.",
      keyboard: [
        ...rows(perks, 2),
        [{ text: `💰 Зарплата: ${pay} · сменить`, callback_data: "pay" }],
        [{ text: "← Сфера", callback_data: "go:cats" }, { text: "Готово ✅", callback_data: "done" }],
      ],
    };
  }
  // done
  return {
    text: `Готово! Буду присылать новые вакансии: ${summary(sub)}.\n\nПишу раз в час, если есть что-то новое, с 8 до 22 часов.`,
    keyboard: [[{ text: "⚙️ Изменить", callback_data: "go:city" }, { text: "Остановить", callback_data: "stop" }]],
  };
}

// Нажатие кнопки → новая подписка и экран, который показать
export function press(sub, data) {
  const [action, arg] = data.split(":");
  const next = { ...sub, categories: [...sub.categories], perks: [...sub.perks] };
  switch (action) {
    case "city":
      next.city = arg === "all" ? null : CITY[arg] ? arg : next.city;
      return { sub: next, show: "cats" };
    case "cat":
      if (CATEGORY[arg]) next.categories = toggle(next.categories, arg);
      return { sub: next, show: "cats" };
    case "perk": {
      const value = arg === SALARY ? SALARY : options.perks[Number(arg)];
      if (value) next.perks = toggle(next.perks, value);
      return { sub: next, show: "perks" };
    }
    case "pay": {
      const steps = [0, ...options.pay];
      next.min_pay = steps[(steps.indexOf(next.min_pay) + 1) % steps.length];
      return { sub: next, show: "perks" };
    }
    case "go":
      return { sub: next, show: ["city", "cats", "perks"].includes(arg) ? arg : "city" };
    case "done":
      next.active = 1;
      return { sub: next, show: "done" };
    case "stop":
      next.active = 0;
      return { sub: next, show: "stopped" };
    default:
      return { sub: next, show: "city" };
  }
}

// Вакансия из feed.json сайта: {id, city, category, perks, pay, html}
export function matches(sub, v) {
  return (
    (!sub.city || v.city === sub.city) &&
    (!sub.categories.length || sub.categories.includes(v.category)) &&
    v.pay >= sub.min_pay &&
    sub.perks.every((p) => (p === SALARY ? v.pay > 0 : v.perks.includes(p)))
  );
}

export function examples(sub, vacancies, limit = 3) {
  const hits = vacancies.filter((v) => matches(sub, v)).slice(0, limit);
  if (!hits.length) return "Сейчас подходящих вакансий нет. Как только появятся, сразу пришлю.";
  return ["Вот последние подходящие:", ...hits.map((v) => v.html)].join("\n\n");
}

// Секрет вебхука выводим из токена бота, чтобы не заводить ещё один секрет
export async function webhookSecret(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

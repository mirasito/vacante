// Логика бота без сети и базы: экраны настройки подписки, разбор нажатий, подбор вакансий.
// Списки городов, сфер и условий лежат в options.json; тест на Python сверяет их с сайтом.
import options from "./options.json" with { type: "json" };

export const SALARY = "salary"; // условие «С зарплатой», как в vacante/digest.py
const CITY = Object.fromEntries(options.cities);
const CATEGORY = Object.fromEntries(options.categories);

export function newSubscription() {
  return { city: null, categories: [], perks: [], min_pay: 0, active: 0, setup: null };
}

export function fromRow(row) {
  if (!row) return newSubscription();
  return {
    city: row.city || null,
    categories: row.categories ? row.categories.split(",") : [],
    perks: row.perks ? row.perks.split("|") : [],
    min_pay: Number(row.min_pay) || 0,
    active: Number(row.active) || 0,
    // У строк до миграции 0014 шаг не записан. Раз подписка активна, человек её включил: это done
    setup: row.setup || (Number(row.active) ? "done" : null),
  };
}

export function toRow(sub) {
  return [sub.city, sub.categories.join(","), sub.perks.join("|"), sub.min_pay, sub.active, sub.setup ?? null];
}

// Шаг настройки подписки (subscribers.setup): city — увидел вопрос «Где ищете работу?», cats — выбрал город,
// perks — открыл условия. Итог: done — нажал «Готово», stopped — «Остановить» или /stop. Пусто — только /start
// или строка до миграции 0014. По шагу видно, где настройку бросают, и кому один раз о ней напомнить (nudgeScreen)
const STEPS = ["city", "cats", "perks"];

/**
 * Шаг после того, как человеку показали экран step. Помним самый дальний: «← Город» шаг не уменьшает.
 * Итог (done, stopped) от просмотра экранов не меняется, а после нового выбора (changed) шаги считаются заново.
 */
export function reached(setup, step, changed = false) {
  if (setup === "done" || setup === "stopped") return changed ? step : setup;
  return STEPS.indexOf(setup) > STEPS.indexOf(step) ? setup : step;
}

// Условие «Смены и подработка» (vacante/shifts.py): последнее в options.perks, чтобы номера кнопок старых условий не сдвинулись
export const SHIFT = "Смены и подработка";

/**
 * Подписка из приложения: t.me/vacantekz_bot?start=sub_<город>_<сфера|all>_<зарплата от>[_s].
 * _s в конце — только смены и подработка (кнопка «Смены» в ленте приложения).
 * Кнопка «Пришлём, когда появится» в ленте, когда подходящих вакансий нет. null, если ссылка битая.
 */
export function fromLink(arg) {
  const m = /^sub_([a-z-]+)_([a-z]+)_(\d{1,7})(_s)?$/.exec(arg || "");
  if (!m || !CITY[m[1]] || (m[2] !== "all" && !CATEGORY[m[2]])) return null;
  return { city: m[1], categories: m[2] === "all" ? [] : [m[2]], perks: m[4] ? [SHIFT] : [], min_pay: Number(m[3]), active: 1 };
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
      // Закончить можно уже здесь: раньше «Готово» было только на экране условий, до него доходили не все,
      // а без «Готово» подписка не включается и человек ничего не получает
      keyboard: [
        ...rows(cats, 2),
        [{ text: "← Город", callback_data: "go:city" }, { text: "Условия и зарплата →", callback_data: "go:perks" }],
        [{ text: "Готово ✅", callback_data: "done" }],
      ],
    };
  }
  if (name === "perks") {
    const perks = [[SALARY, "С зарплатой"], ...options.perks.map((p, i) => [String(i), p])].map(([key, title]) => {
      const value = key === SALARY ? SALARY : options.perks[Number(key)];
      return { text: mark(sub.perks.includes(value), title), callback_data: `perk:${key}` };
    });
    const pay = sub.min_pay ? `от ${money(sub.min_pay)} ₸` : "любая";
    return {
      text: "Что для вас важно? Пришлю вакансии, где есть хотя бы одно из отмеченного. Это можно пропустить.\nЗарплату за смену и за час считаю как полный месяц.",
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

// Напоминание тому, кто начал настраивать подписку и не включил её: один раз (index.js nudgeSubscribers).
// Город не выбран (шаг city): тот же вопрос ещё раз. Выбран: говорим, что будем присылать, а включает человек кнопкой
export function nudgeScreen(sub) {
  if (sub.setup === "city") {
    const { text, keyboard } = screen("city", sub);
    return { text: `Вы просили присылать вакансии, но не выбрали город, поэтому я пока ничего не присылаю.\n\n${text}`, keyboard };
  }
  return {
    text:
      "Вы просили присылать вакансии, но не закончили настройку, поэтому я пока ничего не присылаю.\n\n" +
      `Могу присылать новые вакансии: ${summary(sub)}. Включить?`,
    keyboard: [
      [{ text: "✅ Включить", callback_data: "done" }],
      [{ text: "⚙️ Настроить", callback_data: "go:city" }, { text: "Не нужно", callback_data: "stop" }],
    ],
  };
}

// Кнопка приложения со свайпами (app/, выложено на сайте в /app/): открывает его внутри Telegram.
// Город передаём в адресе, чтобы лента сразу открылась на нём
export function appButton(siteUrl, city) {
  const url = `${siteUrl}/app/${city ? `?city=${city}` : ""}`;
  return { text: "🃏 Листать вакансии свайпами", web_app: { url } };
}

// Нажатие кнопки → новая подписка и экран, который показать
export function press(sub, data) {
  const [action, arg] = data.split(":");
  const next = { ...sub, categories: [...sub.categories], perks: [...sub.perks] };
  // Экран настройки и шаг, до которого человек с ним дошёл. changed: он что-то выбрал, а не только открыл экран
  const show = (name, changed) => ({ sub: { ...next, setup: reached(sub.setup, name, changed) }, show: name });
  switch (action) {
    case "city":
      next.city = arg === "all" ? null : CITY[arg] ? arg : next.city;
      return show("cats", true);
    case "cat":
      if (CATEGORY[arg]) next.categories = toggle(next.categories, arg);
      return show("cats", true);
    case "perk": {
      const value = arg === SALARY ? SALARY : options.perks[Number(arg)];
      if (value) next.perks = toggle(next.perks, value);
      return show("perks", true);
    }
    case "pay": {
      const steps = [0, ...options.pay];
      next.min_pay = steps[(steps.indexOf(next.min_pay) + 1) % steps.length];
      return show("perks", true);
    }
    case "go":
      return show(["city", "cats", "perks"].includes(arg) ? arg : "city");
    case "done":
      next.active = 1;
      next.setup = "done";
      return { sub: next, show: "done" };
    case "stop":
      next.active = 0;
      next.setup = "stopped";
      return { sub: next, show: "stopped" };
    default:
      return show("city");
  }
}

// Вакансия из feed.json сайта: {id, city, category, perks, pay, html}
export function matches(sub, v) {
  return (
    (!sub.city || v.city === sub.city) &&
    (!sub.categories.length || sub.categories.includes(v.category)) &&
    v.pay >= sub.min_pay &&
    (!sub.perks.includes(SALARY) || v.pay > 0) &&
    // Остальные условия — любое из отмеченных (как в vacante/digest.py), а не все сразу
    (sub.perks.every((p) => p === SALARY) || sub.perks.some((p) => p !== SALARY && v.perks.includes(p)))
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

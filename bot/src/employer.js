// Вакансии от работодателей: анкета в боте, проверка модератором и отклики кандидатов.
// Здесь только тексты и разбор ответов, без сети и базы, чтобы всё проверялось тестами.
import options from "./options.json" with { type: "json" };

const CITY = Object.fromEntries(options.cities);
export const BOT_USERNAME = "vacantekz_bot";
export const MAX_PENDING = 3; // столько вакансий одного работодателя может ждать проверки сразу

export const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

// Вопросы анкеты по порядку. null в поле значит «ещё не спрашивали», "" значит «пропущено».
export const STEPS = [
  { field: "city", ask: "В каком городе работа?" },
  { field: "title", ask: "Кого ищете? Напишите должность, например «Официант» или «Повар, помощник повара».", max: 80 },
  { field: "company", ask: "Как называется заведение или компания?", max: 80 },
  { field: "salary", ask: "Какая зарплата? Например «12 000 ₸ за смену» или «от 250 000 ₸ в месяц».", max: 80 },
  { field: "schedule", ask: "Какой график? Например «2/2 с 10:00 до 22:00».", max: 80, optional: true },
  { field: "address", ask: "Где работать? Улица и дом или ТЦ, чтобы кандидат понял, удобно ли добираться.", max: 120, optional: true },
  {
    field: "details",
    ask:
      "Что ещё важно знать кандидату: обязанности, условия (питание, развозка, оформление), требования. Одним сообщением. " +
      "Телефон писать не нужно: отклики придут вам сюда.",
    max: 1000,
    optional: true,
  },
];
const FIELDS = STEPS.map((s) => s.field);

export const STATUS = { draft: "черновик", pending: "на проверке", approved: "опубликована", rejected: "отклонена", closed: "закрыта" };

export function newJob() {
  return Object.fromEntries(FIELDS.map((f) => [f, null]));
}

export function nextStep(job) {
  return STEPS.find((s) => job[s.field] == null) || null;
}

function rows(buttons, perRow) {
  const out = [];
  for (let i = 0; i < buttons.length; i += perRow) out.push(buttons.slice(i, i + perRow));
  return out;
}

const CANCEL = { text: "Отменить", callback_data: "jobcancel" };

// Экран вопроса анкеты
export function askScreen(step) {
  if (step.field === "city") {
    const cities = options.cities.map(([slug, title]) => ({ text: title, callback_data: `jobcity:${slug}` }));
    return { text: step.ask, keyboard: [...rows(cities, 3), [CANCEL]] };
  }
  const keyboard = step.optional ? [[{ text: "Пропустить", callback_data: `skip:${step.field}` }, CANCEL]] : [[CANCEL]];
  return { text: step.ask, keyboard };
}

// Ответ текстом на текущий вопрос → обновлённая вакансия или ошибка
export function answer(job, field, text) {
  const step = STEPS.find((s) => s.field === field);
  if (!step || field === "city") return { error: "Выберите город кнопкой." };
  const value = String(text ?? "").trim().replace(/\s+\n/g, "\n");
  if (!value) return { error: "Напишите ответ текстом." };
  if (value.length > step.max) return { error: `Слишком длинно: ${value.length} символов. Сократите до ${step.max}, пожалуйста.` };
  return { job: { ...job, [field]: value } };
}

// Нажатие кнопки анкеты → обновлённая вакансия, или null, если кнопка из старого сообщения
export function pressed(job, data) {
  const [action, value] = data.split(":");
  if (action === "jobredo") return { ...job, ...newJob() };
  if (action === "jobcity") return job.step === "city" && CITY[value] ? { ...job, city: value } : null;
  const step = STEPS.find((s) => s.field === value);
  if (action === "skip" && step?.optional && job.step === value) return { ...job, [value]: "" };
  return null;
}

export function card(job) {
  const place = [CITY[job.city] || "Казахстан", job.address].filter(Boolean).join(", ");
  const lines = [`<b>${esc(job.title)}</b>`, `🏢 ${esc(job.company)}`, `📍 ${esc(place)}`, `💰 <b>${esc(job.salary)}</b>`];
  if (job.schedule) lines.push(`🕒 ${esc(job.schedule)}`);
  if (job.details) lines.push("", esc(job.details));
  return lines.join("\n");
}

export function previewScreen(job) {
  return {
    text: `Проверьте вакансию:\n\n${card(job)}\n\nЕсли всё верно, отправьте на проверку. После проверки вакансия появится на vacante.kz и в подборках подписчикам бота.`,
    keyboard: [
      [{ text: "✅ Отправить на проверку", callback_data: "jobsend" }],
      [{ text: "Заполнить заново", callback_data: "jobredo" }, CANCEL],
    ],
  };
}

export function employerName(from) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  return from.username ? `${name} (@${from.username})` : name;
}

// Карточка у модераторов: пока вакансия ждёт, с кнопками решения, потом с тем, кто и что решил
export function moderationScreen(job) {
  const head = `🆕 Вакансия от работодателя №${job.id}\nОт: ${esc(job.employer_name)}\n\n${card(job)}\n\n`;
  if (job.status !== "pending") return { text: head + decisionLine(job), keyboard: [] };
  return {
    text:
      head +
      "Агент проверит и оформит её в течение часа (с 8 до 22). Кнопки нужны, только если хотите решить сами: " +
      "«Опубликовать» сразу выпустит вакансию на сайт как есть, а в канал она выйдет после оформления агентом.",
    keyboard: [[
      { text: "✅ Опубликовать", callback_data: `mod:ok:${job.id}` },
      { text: "❌ Отклонить", callback_data: `mod:no:${job.id}` },
    ]],
  };
}

// boost: если включена услуга «Срочно», под сообщением кнопка поднять вакансию
export function approvedScreen(job, boost = null) {
  if (!boost) return { text: approvedText(job), keyboard: [] };
  const more =
    `\n\nНужно быстрее? «🔥 Срочно» за ${money(boost.price)}: ${boost.days} дней первой в списке города на сайте ` +
    "с яркой пометкой и закреплённый пост в канале.";
  return { text: approvedText(job) + more, keyboard: [[boostButton(job, boost)]] };
}

export function approvedText(job) {
  return (
    `✅ Вакансия прошла проверку и публикуется:\n\n${card(job)}\n\n` +
    "Через несколько минут она будет на vacante.kz и в подборках подписчикам бота, а вакансии Астаны и Алматы " +
    "ещё и в наших Telegram-каналах. Отклики кандидатов придут сюда.\n\nНашли сотрудника? Закройте вакансию: /myjobs"
  );
}

export function rejectedText(job, reason) {
  const why = reason
    ? `Причина: ${esc(reason)}`
    : "Мы размещаем только настоящие вакансии с понятной зарплатой и условиями, без предоплат и «работы в интернете».";
  return `Вакансию «${esc(job.title)}» не опубликовали. ${why}\n\nМожно исправить и отправить снова: /vacancy`;
}

// Строка под карточкой у модераторов после решения
export function decisionLine(job) {
  const by = job.decided_by ? `: ${esc(job.decided_by)}` : "";
  if (job.status === "approved") return `✅ Опубликована${by}`;
  if (job.status === "rejected") return `❌ Отклонена${by}`;
  return `Уже ${STATUS[job.status]}`;
}

// Решение агента-модератора (см. .claude/skills/moderate-vacancies): оформленные поля вакансии
const PERIODS = ["month", "day", "hour"];
const PAY_LIMITS = { hour: [300, 15_000], day: [2_000, 150_000], month: [40_000, 5_000_000] }; // как в parse.py

export function reviewFields(job, fields = {}) {
  const next = { ...job };
  for (const step of STEPS.filter((s) => s.field !== "city")) {
    if (fields[step.field] === undefined) continue;
    const value = String(fields[step.field] ?? "").trim();
    if (!value && !step.optional) return { error: `${step.field}: пусто` };
    if (value.length > step.max) return { error: `${step.field}: длиннее ${step.max}` };
    next[step.field] = value;
  }
  if (fields.salary_period !== undefined || fields.salary_min !== undefined || fields.salary_max !== undefined) {
    const period = fields.salary_period ?? null;
    const pay = [fields.salary_min ?? null, fields.salary_max ?? null];
    if (period === null) {
      if (pay.some((v) => v !== null)) return { error: "salary_period: нужен вместе с суммой" };
    } else {
      if (!PERIODS.includes(period)) return { error: "salary_period: month, day или hour" };
      const [lo, hi] = PAY_LIMITS[period];
      if (pay.every((v) => v === null)) return { error: "salary_min или salary_max: нужна сумма" };
      if (pay.some((v) => v !== null && !(Number.isInteger(v) && v >= lo && v <= hi))) {
        return { error: `salary: сумма за ${period} вне ${lo}–${hi}` };
      }
      if (pay[0] !== null && pay[1] !== null && pay[0] > pay[1]) return { error: "salary_min больше salary_max" };
    }
    [next.salary_min, next.salary_max, next.salary_period] = [...pay, period];
  }
  return { job: next };
}

// Ключ, с которым moderate.yml передаёт боту решения агента: sha256("moderation:" + токен бота)
export async function moderationKey(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`moderation:${token}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function applyIntro(job) {
  return (
    `Отклик на вакансию:\n\n${card(job)}\n\n` +
    "Напишите одним сообщением о себе: имя, возраст, опыт и номер телефона. " +
    "Или нажмите кнопку внизу, чтобы отправить номер из Telegram."
  );
}

export const CONTACT_KEYBOARD = {
  keyboard: [[{ text: "📱 Отправить мой номер", request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

export function applicationText(job, from, text, phone) {
  const who = [employerName(from), phone ? `📱 ${phone}` : null].filter(Boolean).join(", ");
  const link = from.username ? "" : `\n<a href="tg://user?id=${from.id}">Написать кандидату</a>`;
  const about = text ? esc(text.slice(0, 2000)) + "\n\n" : "";
  return `📩 Отклик на «${esc(job.title)}»\n\n${about}👤 ${esc(who)}${link}`;
}

// Список вакансий работодателя: jobs с полем applications (число откликов).
// boost: условия «🔥 Срочно» (boostOffer) или null, если платная услуга выключена.
export function myJobsScreen(jobs, boost = null, now = new Date()) {
  if (!jobs.length) {
    return { text: "У вас пока нет вакансий. Разместить: /vacancy", keyboard: [] };
  }
  const lines = jobs.map((j) => `№${j.id} <b>${esc(j.title)}</b>, ${esc(CITY[j.city] || "")}: ${STATUS[j.status]}` +
    (j.status === "approved" ? `, откликов: ${j.applications}` : "") +
    (j.status === "approved" && isBoosted(j, now) ? `, 🔥 срочно до ${localDate(j.boost_until)}` : ""));
  const keyboard = [];
  for (const j of jobs.filter((j) => j.status === "approved" || j.status === "pending")) {
    if (boost && j.status === "approved") keyboard.push([boostButton(j, boost, now)]);
    keyboard.push([{ text: `Закрыть №${j.id} ${j.title}`.slice(0, 60), callback_data: `close:${j.id}` }]);
  }
  return { text: `Ваши вакансии:\n\n${lines.join("\n")}\n\nНовая вакансия: /vacancy`, keyboard };
}

// Платная услуга «🔥 Срочно»: вакансия первой в списке своего города на сайте с пометкой и повторный пост
// в канале. Оплата переводом на Kaspi, модератор подтверждает её кнопкой. Без реквизитов (секрет
// KASPI_DETAILS) услуга выключена, и кнопки не показываются.
export function boostOffer(env) {
  const kaspi = String(env.KASPI_DETAILS || "").trim();
  if (!kaspi) return null;
  return { price: Number(env.BOOST_PRICE) || 3000, days: Number(env.BOOST_DAYS) || 7, kaspi };
}

const money = (n) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ₸`;
const sqliteTime = (s) => new Date(`${String(s).replace(" ", "T")}Z`);  // datetime('now') в D1 — это UTC

export function isBoosted(j, now = new Date()) {
  return Boolean(j.boost_until) && sqliteTime(j.boost_until) > now;
}

// Дата по времени Казахстана (UTC+5): «05.11»
export function localDate(s) {
  const d = new Date(sqliteTime(s).getTime() + 5 * 3600e3);
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function boostButton(j, boost, now = new Date()) {
  const what = isBoosted(j, now) ? "Продлить «Срочно»" : "🔥 Поднять";
  return { text: `${what} №${j.id}: ${money(boost.price)}`, callback_data: `boost:${j.id}` };
}

export function boostScreen(j, boost) {
  const channel = ["astana", "almaty"].includes(j.city) ? `\n2. Пост в нашем канале ${CITY[j.city]} с той же пометкой, закреплённый наверху канала на все ${boost.days} дней.` : "";
  return {
    text:
      `🔥 <b>«Срочно» на ${boost.days} дней за ${money(boost.price)}</b>\n\n${card(j)}\n\n` +
      `1. Вакансия первой в списке города на vacante.kz с пометкой «🔥 Срочно».${channel}\n\n` +
      `Как оплатить: переведите <b>${money(boost.price)}</b> на Kaspi\n${esc(boost.kaspi)}\n` +
      `В комментарии к переводу напишите «№${j.id}». Потом нажмите кнопку ниже: мы сверим перевод и поднимем вакансию.`,
    keyboard: [[{ text: "✅ Я оплатил", callback_data: `paid:${j.id}` }]],
  };
}

export const PAYMENT_STATUS = { pending: "ждёт проверки", confirmed: "подтверждена", rejected: "не найдена" };

// Карточка оплаты у модераторов: пока ждёт, с кнопками, потом с решением
export function paymentScreen(p, j) {
  const head =
    `💳 Оплата «Срочно» №${p.id}: <b>${money(p.amount)}</b> на ${p.days} дней\n` +
    `Вакансия №${j.id} «${esc(j.title)}», ${esc(j.company)}\nОт: ${esc(j.employer_name)}\n\n`;
  if (p.status !== "pending") {
    const by = p.decided_by ? `: ${esc(p.decided_by)}` : "";
    return { text: head + (p.status === "confirmed" ? `✅ Деньги пришли${by}` : `❌ Перевод не найден${by}`), keyboard: [] };
  }
  return {
    text: head + `Проверьте в Kaspi перевод на ${money(p.amount)} с комментарием «№${j.id}».`,
    keyboard: [[
      { text: "✅ Деньги пришли", callback_data: `pay:ok:${p.id}` },
      { text: "❌ Не пришли", callback_data: `pay:no:${p.id}` },
    ]],
  };
}

export function paymentWaitText(j) {
  return `⏳ Сверяем перевод за вакансию №${j.id} «${esc(j.title)}». Обычно это до пары часов днём. Напишу, как только поднимем.`;
}

export function boostedText(j) {
  return (
    `🔥 Оплата получена, спасибо! Вакансия «${esc(j.title)}» отмечена «Срочно» до ${localDate(j.boost_until)}: ` +
    "через несколько минут она будет первой в списке своего города на vacante.kz." +
    (["astana", "almaty"].includes(j.city) ? ` А в нашем канале ${CITY[j.city]} выйдет пост, закреплённый до конца срока.` : "") +
    "\n\nВаши вакансии: /myjobs"
  );
}

export function paymentRejectedText(j) {
  return (
    `Мы не нашли перевод за вакансию №${j.id} «${esc(j.title)}». Если вы уже переводили, проверьте сумму и комментарий ` +
    "и нажмите «Я оплатил» ещё раз: /myjobs"
  );
}

export const ADMIN_STATUSES = ["creator", "administrator"];

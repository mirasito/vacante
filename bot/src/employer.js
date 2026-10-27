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

// Список вакансий работодателя: jobs с полем applications (число откликов)
export function myJobsScreen(jobs) {
  if (!jobs.length) {
    return { text: "У вас пока нет вакансий. Разместить: /vacancy", keyboard: [] };
  }
  const lines = jobs.map((j) => `№${j.id} <b>${esc(j.title)}</b>, ${esc(CITY[j.city] || "")}: ${STATUS[j.status]}` +
    (j.status === "approved" ? `, откликов: ${j.applications}` : ""));
  const keyboard = jobs
    .filter((j) => j.status === "approved" || j.status === "pending")
    .map((j) => [{ text: `Закрыть №${j.id} ${j.title}`.slice(0, 60), callback_data: `close:${j.id}` }]);
  return { text: `Ваши вакансии:\n\n${lines.join("\n")}\n\nНовая вакансия: /vacancy`, keyboard };
}

export const ADMIN_STATUSES = ["creator", "administrator"];

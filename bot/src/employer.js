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
  const lines = [`<b>${esc(job.title)}</b>`, `🏢 ${esc(job.company)}`, `📍 ${esc(place)}`, `💰 ${esc(job.salary)}`];
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

export function moderationScreen(job) {
  return {
    text: `🆕 Вакансия от работодателя №${job.id}\nОт: ${esc(job.employer_name)}\n\n${card(job)}`,
    keyboard: [[
      { text: "✅ Опубликовать", callback_data: `mod:ok:${job.id}` },
      { text: "❌ Отклонить", callback_data: `mod:no:${job.id}` },
    ]],
  };
}

export function approvedText(job) {
  return (
    `✅ Вакансия «${esc(job.title)}» прошла проверку. В течение часа она появится на vacante.kz и в подборках ` +
    "подписчикам бота, а вакансии Астаны и Алматы ещё и в наших Telegram-каналах. Отклики кандидатов придут сюда.\n\n" +
    "Нашли сотрудника? Закройте вакансию: /myjobs"
  );
}

export function rejectedText(job) {
  return (
    `Вакансию «${esc(job.title)}» не опубликовали. Мы размещаем только настоящие вакансии с понятной зарплатой ` +
    "и условиями, без предоплат и «работы в интернете». Можно исправить и отправить снова: /vacancy"
  );
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

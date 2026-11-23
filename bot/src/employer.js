// Вакансии от работодателей: анкета в боте, проверка модератором и отклики кандидатов.
// Здесь только тексты и разбор ответов, без сети и базы, чтобы всё проверялось тестами.
import options from "./options.json" with { type: "json" };
import { NEED, parseTime, SHIFT_STEPS, shiftButtons, shiftCard, validDate } from "./shift.js";

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

export const STATUS = { draft: "черновик", payment: "ждёт оплаты", pending: "на проверке", approved: "опубликована", rejected: "отклонена", closed: "закрыта" };

// Анкета вакансии или смены (kind = 'shift', см. shift.js)
export const stepsFor = (job) => (job && job.kind === "shift" ? SHIFT_STEPS : STEPS);

export function newJob(kind = "vacancy") {
  const fields = kind === "shift" ? [...SHIFT_STEPS.map((s) => s.field), "shift_end"] : FIELDS;
  return Object.fromEntries(fields.map((f) => [f, null]));
}

export function nextStep(job) {
  return stepsFor(job).find((s) => job[s.field] == null) || null;
}

// Вопросы, на которые отвечают только кнопками
const BUTTON_FIELDS = ["city", "shift_date", "need"];

function rows(buttons, perRow) {
  const out = [];
  for (let i = 0; i < buttons.length; i += perRow) out.push(buttons.slice(i, i + perRow));
  return out;
}

const CANCEL = { text: "Отменить", callback_data: "jobcancel" };

// Кнопка на первом вопросе: анкету открыл соискатель (ссылки «Нанимаете?» и «Нужны люди на смену?» видят все)
export const SEEKER_BUTTON = { text: "🙋 Я ищу работу, а не сотрудников", callback_data: "jobseeker" };

// Частые должности кнопками: на вопросе «Кого ищете?» уходило больше всего работодателей
export const TITLE_CHOICES = {
  vacancy: ["Официант", "Повар", "Бариста", "Продавец-консультант", "Кассир", "Администратор", "Уборщица", "Грузчик", "Курьер"],
  shift: ["Официант", "Повар", "Помощник повара", "Грузчик", "Разнорабочий", "Уборщица", "Промоутер", "Кассир", "Курьер"],
};
const titleChoices = (kind) => TITLE_CHOICES[kind === "shift" ? "shift" : "vacancy"];

// Экран вопроса анкеты
export function askScreen(step, now = new Date()) {
  let text = `${progress(step)}${step.ask}`;
  if (step.field === "shift_date" || step.field === "need") return { text, keyboard: [...shiftButtons(step.field, now), [CANCEL]] };
  if (step.field === "city") {
    const cities = options.cities.map(([slug, title]) => ({ text: title, callback_data: `jobcity:${slug}` }));
    return { text, keyboard: [...rows(cities, 3), [SEEKER_BUTTON], [CANCEL]] };
  }
  if (step.field === "title") {
    const kind = SHIFT_STEPS.includes(step) ? "shift" : "vacancy";
    const titles = titleChoices(kind).map((t, i) => ({ text: t, callback_data: `jobtitle:${i}` }));
    text += "\n\nНажмите кнопку или напишите свою должность.";
    return { text, keyboard: [...rows(titles, 3), [CANCEL]] };
  }
  const keyboard = step.optional ? [[{ text: "Пропустить", callback_data: `skip:${step.field}` }, CANCEL]] : [[CANCEL]];
  return { text, keyboard };
}

// «Вопрос 2 из 7»: работодатель видит, сколько осталось до конца анкеты
function progress(step) {
  const steps = SHIFT_STEPS.includes(step) ? SHIFT_STEPS : STEPS;
  const i = steps.indexOf(step);
  return i < 0 ? "" : `<i>Вопрос ${i + 1} из ${steps.length}</i>\n`;
}

// Ответ текстом на текущий вопрос → обновлённая вакансия или ошибка
export function answer(job, field, text) {
  const step = stepsFor(job).find((s) => s.field === field);
  if (!step || BUTTON_FIELDS.includes(field)) return { error: field === "city" || !step ? "Выберите город кнопкой." : "Выберите кнопкой." };
  const value = String(text ?? "").trim().replace(/\s+\n/g, "\n");
  if (!value) return { error: "Напишите ответ текстом." };
  if (value.length > step.max) return { error: `Слишком длинно: ${value.length} символов. Сократите до ${step.max}, пожалуйста.` };
  if (field === "shift_start") {
    const t = parseTime(value);
    if (!t) return { error: "Не понял время. Напишите начало и конец, например «10:00–22:00» или «с 9 до 18»." };
    return { job: { ...job, shift_start: t.start, shift_end: t.end } };
  }
  return { job: { ...job, [field]: value } };
}

// Нажатие кнопки анкеты → обновлённая вакансия, или null, если кнопка из старого сообщения
export function pressed(job, data, now = new Date()) {
  const [action, value] = data.split(":");
  if (action === "jobredo") return { ...job, ...newJob(job.kind) };
  if (action === "jobtitle") {
    const title = titleChoices(job.kind)[Number(value)];
    return job.step === "title" && title ? { ...job, title } : null;
  }
  if (action === "jobcity") return job.step === "city" && CITY[value] ? { ...job, city: value } : null;
  if (action === "jobdate") return job.step === "shift_date" && validDate(value, now) ? { ...job, shift_date: value } : null;
  if (action === "jobneed") return job.step === "need" && NEED.includes(Number(value)) ? { ...job, need: Number(value) } : null;
  const step = stepsFor(job).find((s) => s.field === value);
  if (action === "skip" && step?.optional && job.step === value) return { ...job, [value]: "" };
  return null;
}

export function card(job) {
  if (job.kind === "shift") return shiftCard(job);
  const place = [CITY[job.city] || "Казахстан", job.address].filter(Boolean).join(", ");
  const lines = [`<b>${esc(job.title)}</b>`, `🏢 ${esc(job.company)}`, `📍 ${esc(place)}`, `💰 <b>${esc(job.salary)}</b>`];
  if (job.schedule) lines.push(`🕒 ${esc(job.schedule)}`);
  if (job.details) lines.push("", esc(job.details));
  return lines.join("\n");
}

// Предпросмотр анкеты и выбор тарифа. price: цена «Базового» (postPrice) или 0, если размещение бесплатное
// (модератору или без реквизитов). boost: условия «Про» (boostOffer) или null. credits: сколько «Про» осталось в пакетах.
// admin: модератор каналов, ему ещё кнопка «🛡 Без оплаты (модератор)».
export function previewScreen(job, price = 0, boost = null, credits = 0, now = new Date(), admin = false) {
  const what = job.kind === "shift" ? "смену" : "вакансию";
  const where = job.kind === "shift"
    ? "смена появится на vacante.kz в разделе «Подработка и смены» и в подборках"
    : "вакансия появится на vacante.kz и в подборках подписчикам бота";
  const head = `Проверьте ${what}:\n\n${card(job)}\n\n`;
  const redo = [{ text: "Заполнить заново", callback_data: "jobredo" }, CANCEL];
  if (!price) {
    return {
      text: `${head}Если всё верно, отправьте на проверку, это до часа. Потом ${where}.`,
      keyboard: [[{ text: "✅ Отправить на проверку", callback_data: "jobsend" }], redo],
    };
  }
  const pro = boost && offerFor(boost, job, now);
  const lines = [`Выберите тариф. После оплаты и проверки (обычно до часа) ${where}.`, "", `✅ <b>Базовый, ${money(price)}</b>: ${tariffText("basic", job)}`];
  if (pro) lines.push(`🔥 <b>Про, ${money(pro.price)}</b>: ${tariffText("pro", job, pro)}`);
  const keyboard = [[{ text: `✅ Базовый: ${money(price)}`, callback_data: "jobsend" }]];
  if (pro) keyboard.push([{ text: `🔥 Про: ${money(pro.price)}`, callback_data: "jobpro" }]);
  if (pro && job.kind !== "shift" && credits > 0) {
    keyboard.push([{ text: `🔥 Про из пакета, осталось ${credits}`, callback_data: "jobcredit" }]);
  } else if (pro && job.kind !== "shift" && boost.packs?.length) {
    keyboard.push([{ text: "📦 Пакеты Про со скидкой", callback_data: "packs" }]);
  }
  if (admin) keyboard.push([{ text: "🛡 Без оплаты (вы модератор)", callback_data: "jobfree" }]);
  keyboard.push(redo);
  return { text: head + lines.join("\n"), keyboard };
}

// Что даёт тариф, одной строкой
export function tariffText(kind, job, pro = null) {
  if (kind === "basic") {
    return job.kind === "shift"
      ? "раздел «Подработка и смены» на сайте и в приложении, подборки тем, кто ищет подработку, канал города."
      : "сайт и приложение на 30 дней, подборки подписчикам бота, пост в канале города, отклики сюда в чат.";
  }
  // INSTAGRAM в wrangler.toml: Про-вакансии выходят в Instagram vacante (vacante/instagram.py)
  const ig = pro && pro.instagram ? `, пост и сторис в нашем Instagram ${pro.instagram}` : "";
  if (job.kind === "shift") return `всё из Базового, смена первой в разделе города до её начала с пометкой «🔥 Срочно», закреп в канале${ig}.`;
  return `всё из Базового, ${pro.days} дней первой в списке города с пометкой «🔥 Срочно», закреп в канале города ` +
    `и повторный пост через неделю${ig}, в конце итог по откликам.`;
}

// Свои Telegram-каналы vacante по городам (город → @канал). Точный список работающих каналов бот берёт
// из feed.json сайта (site.js), это запасной вариант, если сайт не ответил.
export const DEFAULT_CHANNELS = { astana: "@vacanteastana", almaty: "@vacantealmaty" };

// Где выйдет вакансия этого города: «и в канале @vacantealmaty» или пусто, если своего канала там нет
function inChannel(city, channels) {
  const channel = (channels || DEFAULT_CHANNELS)[city];
  return channel ? ` и в нашем Telegram-канале ${channel}` : "";
}

// Меню работодателя: кнопка «🏢 Ищу сотрудников» на /start, команда /employer и ссылка ?start=employer.
// price: цена размещения (0, если бесплатно), boost: условия «Срочно» или null.
export const EMPLOYER_BUTTON = { text: "🏢 Ищу сотрудников", callback_data: "emp" };

export function employerMenu(price = 0, boost = null, siteUrl = SITE) {
  const cost = price ? `Тариф Базовый: ${money(price)}.` : "Размещение бесплатное.";
  const faster = boost ? ` Нужно быстрее: тариф Про за ${money(boost.price)}, ${boost.days} дней первой в городе и закреп в канале.` +
    (boost.packs?.length ? ` Пакеты Про дешевле: ${boost.packs.map((p) => `${p.count} за ${money(p.price)}`).join(", ")}.` : "") : "";
  return {
    text:
      "🏢 <b>Найдём сотрудников</b>\n\n" +
      "Ответьте на несколько вопросов, это пара минут. Мы проверим вакансию (обычно до часа) и выпустим её " +
      "на vacante.kz, в приложении Vacante, в подборках тем, кто ищет работу, и в Telegram-канале вашего города. " +
      "Отклики кандидатов придут сюда, в этот чат.\n\n" +
      `${cost}${faster}\n\n` +
      "📝 <b>Вакансия</b>: постоянная работа.\n⚡ <b>Смена на день</b>: люди на конкретный день, с оплатой за смену.",
    keyboard: [
      [{ text: "📱 Кабинет работодателя", web_app: { url: `${siteUrl}/app/?tab=employer` } }],
      [{ text: "📝 Вакансия", callback_data: "emp:vacancy" }, { text: "⚡ Смена на день", callback_data: "emp:shift" }],
      [{ text: "📋 Мои вакансии и отклики", callback_data: "emp:jobs" }],
      ...(boost?.packs?.length ? [[{ text: "📦 Пакеты Про со скидкой", callback_data: "packs" }]] : []),
      [{ text: "🏢 Профиль компании и заведения", callback_data: "emp:company" }],
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
// channels: свои каналы по городам (DEFAULT_CHANNELS или из feed.json), siteUrl: адрес сайта для ссылки на вакансию
export function approvedScreen(job, boost = null, now = new Date(), channels = DEFAULT_CHANNELS, siteUrl = SITE) {
  boost = offerFor(boost, job, now);
  const text = approvedText(job, channels, siteUrl);
  if (!boost || isBoosted(job, now)) return { text: text + (isBoosted(job, now) ? `\n\n🔥 Тариф Про до ${localDate(job.boost_until)}.` : ""), keyboard: [] };
  const pin = (channels || DEFAULT_CHANNELS)[job.city] ? " и закреплённый пост в канале" : "";
  if (boost.shift) {
    const more = `\n\nНужно быстрее? Тариф Про за ${money(boost.price)}: смена первой в разделе «Подработка и смены» города до её начала${pin}.`;
    return { text: text + more, keyboard: [[boostButton(job, boost)]] };
  }
  const more =
    `\n\nНужно быстрее? Тариф Про за ${money(boost.price)}: ${boost.days} дней первой в списке города на сайте ` +
    `с пометкой «🔥 Срочно»${pin}.`;
  return { text: text + more, keyboard: [[boostButton(job, boost)]] };
}

const SITE = "https://vacante.kz";

// Ссылка на страницу вакансии на сайте: её сборка сайта делает из id вакансии бота (vacante/direct.py)
export const jobUrl = (job, siteUrl = SITE) => `${siteUrl}/v/bot-${job.id}/`;

export function approvedText(job, channels = DEFAULT_CHANNELS, siteUrl = SITE) {
  const link = `\n\n🌐 Страница на сайте (появится через несколько минут): ${jobUrl(job, siteUrl)}`;
  if (job.kind === "shift") {
    return (
      `✅ Смена прошла проверку и публикуется:\n\n${card(job)}\n\n` +
      `Через несколько минут она будет на vacante.kz в разделе «Подработка и смены», в приложении, в подборках тем, ` +
      `кто ищет подработку${inChannel(job.city, channels)}. Кто захочет выйти, нажмёт «Беру смену»: просьба придёт сюда, вы подтвердите одной кнопкой. ` +
      `Когда наберёте всех, смена сама уйдёт с сайта.${link}\n\nВаши смены: /myjobs`
    );
  }
  return (
    `✅ Вакансия прошла проверку и публикуется:\n\n${card(job)}\n\n` +
    `Через несколько минут она будет на vacante.kz, в приложении, в подборках подписчикам бота${inChannel(job.city, channels)}. ` +
    `Отклики кандидатов придут сюда, в этот чат.${link}\n\nВсе отклики и закрыть вакансию: /myjobs`
  );
}

export function rejectedText(job, reason) {
  const why = reason
    ? `Причина: ${esc(reason)}`
    : "Мы размещаем только настоящие вакансии с понятной зарплатой и условиями, без предоплат и «работы в интернете».";
  const refund = job.post_paid ? `\n\nОплату за размещение (${money(job.post_paid)}) вернём на ваш Kaspi в течение дня.` : "";
  return `Вакансию «${esc(job.title)}» не опубликовали. ${why}${refund}\n\nМожно исправить и отправить снова: /vacancy`;
}

// Строка под карточкой у модераторов после решения
export function decisionLine(job) {
  const by = job.decided_by ? `: ${esc(job.decided_by)}` : "";
  if (job.status === "approved") return `✅ Опубликована${by}`;
  if (job.status === "rejected") {
    return `❌ Отклонена${by}` + (job.post_paid ? `\n💸 Работодатель заплатил ${money(job.post_paid)} за размещение: верните перевод.` : "");
  }
  return `Уже ${STATUS[job.status]}`;
}

// Решение агента-модератора (см. .claude/skills/moderate-vacancies): оформленные поля вакансии
const PERIODS = ["month", "day", "hour"];
const PAY_LIMITS = { hour: [300, 15_000], day: [2_000, 150_000], month: [40_000, 5_000_000] }; // как в parse.py

export function reviewFields(job, fields = {}) {
  const next = { ...job };
  for (const step of STEPS.filter((s) => s.field !== "city")) {
    if (fields[step.field] === undefined) continue;
    if (job.kind === "shift" && step.field === "schedule") continue; // день и время смены задаёт сам работодатель кнопками
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

// «📩 Отклики №12»: бот заново присылает сообщения с откликами (хранит только их номера в чате)
export function applicationsIntro(j, shown, total) {
  if (!total) return `На «${esc(j.title)}» пока нет откликов. Как только кто-то откликнется, сообщение придёт сюда.`;
  const lines = [`📩 Отклики на «${esc(j.title)}»: ${total}.`];
  if (shown) lines.push(shown < total ? `Ниже ещё раз последние ${shown}, остальные выше в этом чате.` : "Ниже они ещё раз.");
  else lines.push("Они выше в этом чате.");
  return lines.join(" ");
}

// Список вакансий работодателя: jobs с полем applications (число откликов).
// boost: условия «🔥 Срочно» (boostOffer) или null, если платная услуга выключена.
export function myJobsScreen(jobs, boost = null, now = new Date()) {
  if (!jobs.length) {
    return { text: "У вас пока нет вакансий. Разместить: /vacancy", keyboard: [[{ text: "📝 Разместить вакансию", callback_data: "emp:vacancy" }]] };
  }
  const lines = jobs.map((j) => `№${j.id} ${j.kind === "shift" ? "⚡ " : ""}<b>${esc(j.title)}</b>, ${esc(CITY[j.city] || "")}` +
    (j.kind === "shift" && j.shift_date ? ` ${j.shift_date.slice(8, 10)}.${j.shift_date.slice(5, 7)}` : "") + `: ${STATUS[j.status]}` +
    (j.kind === "shift" && j.status !== "draft" ? `, взяли ${j.confirmed ?? 0} из ${j.need ?? "?"}, просились: ${j.applications}`
      : j.status === "approved" ? `, откликов: ${j.applications}` : "") +
    (j.status === "approved" && isBoosted(j, now) ? `, 🔥 срочно до ${localDate(j.boost_until)}` : ""));
  const keyboard = [];
  for (const j of jobs.filter((j) => ["approved", "pending", "payment"].includes(j.status))) {
    if (j.kind !== "shift" && j.applications > 0) {
      keyboard.push([{ text: `📩 Отклики №${j.id}: ${j.applications}`, callback_data: `apps:${j.id}` }]);
    }
    if (boost && j.status === "approved") keyboard.push([boostButton(j, offerFor(boost, j, now), now)]);
    if (j.status === "payment") keyboard.push([{ text: `💳 Оплатить №${j.id}: ${money(postPriceFor(j, boost, now))}`, callback_data: `postpay:${j.id}` }]);
    keyboard.push([{ text: `Закрыть №${j.id} ${j.title}`.slice(0, 60), callback_data: `close:${j.id}` }]);
  }
  return { text: `Ваши вакансии:\n\n${lines.join("\n")}\n\nОтклики приходят сюда в чат, кнопка «📩 Отклики» покажет их ещё раз. Новая вакансия: /vacancy`, keyboard };
}

// Платная услуга «🔥 Срочно»: вакансия первой в списке своего города на сайте с пометкой и повторный пост
// в канале. Оплата переводом на Kaspi, модератор подтверждает её кнопкой. Без реквизитов (секрет
// KASPI_DETAILS) услуга выключена, и кнопки не показываются.
export function boostOffer(env) {
  const kaspi = String(env.KASPI_DETAILS || "").trim();
  if (!kaspi) return null;
  return { price: Number(env.BOOST_PRICE) || 3990, days: Number(env.BOOST_DAYS) || 14, kaspi,
    shiftPrice: Number(env.SHIFT_BOOST_PRICE) || 1390, postPrice: env.POST_PRICE === undefined ? 990 : Number(env.POST_PRICE) || 0,
    packs: parsePacks(env.PACKS), instagram: String(env.INSTAGRAM || "").trim() };
}

// Пакеты «Про»: PACKS = "3:9990:60,10:29990:90" — сколько вакансий, цена в тенге, сколько дней действует пакет
export function parsePacks(value) {
  return String(value || "").split(",").map((part) => part.trim().split(":").map(Number))
    .filter(([count, price, days]) => count > 0 && price > 0 && days > 0)
    .map(([count, price, days]) => ({ count, price, days }));
}

export function packsScreen(boost, credits = 0) {
  const lines = boost.packs.map((p) =>
    `📦 <b>${p.count} ${vacancies(p.count)} Про за ${money(p.price)}</b>: ${money(Math.round(p.price / p.count))} за одну вместо ${money(boost.price)}, ` +
    `использовать в течение ${p.days} дней.`);
  return {
    text:
      "<b>Пакеты Про</b>\n\nДля сетей и тех, кто нанимает часто. Каждая вакансия из пакета получает тариф Про: " +
      `${boost.days} дней первой в городе, закреп в канале, повторный пост и итог по откликам.\n\n${lines.join("\n")}` +
      (credits ? `\n\nСейчас у вас осталось Про: ${credits}.` : ""),
    keyboard: boost.packs.map((p) => [{ text: `📦 ${p.count} Про: ${money(p.price)}`, callback_data: `pack:${p.count}` }]),
  };
}

export function packPayScreen(pack, boost) {
  return {
    text:
      `📦 <b>Пакет: ${pack.count} ${vacancies(pack.count)} Про за ${money(pack.price)}</b>\n\n` +
      `Как оплатить: переведите <b>${money(pack.price)}</b> на Kaspi\n${esc(boost.kaspi)}\n` +
      `В комментарии к переводу напишите «Пакет ${pack.count}». Потом нажмите кнопку ниже: мы сверим перевод и включим пакет.`,
    keyboard: [[{ text: "✅ Я оплатил", callback_data: `packpaid:${pack.count}` }]],
  };
}

export function packWaitText(pack) {
  return `⏳ Сверяем перевод за пакет «${pack.count} Про». Обычно это до пары часов днём. Напишу, как только включим.`;
}

export function packReadyText(count, until) {
  return (
    `📦 Пакет включён: ${count} ${vacancies(count)} Про до ${localDate(until)}.\n\n` +
    "При новой вакансии выберите «🔥 Про из пакета», а уже опубликованную поднимите в /myjobs кнопкой «🔥 Про». /vacancy"
  );
}

// Итог «Про», когда срок закончился: сколько откликов, и предложение продлить
export function proReportScreen(j, applications, boost) {
  const text =
    `📊 Итог тарифа Про по «${esc(j.title)}»: откликов ${applications}.\n\n` +
    (j.status === "approved" ? "Вакансия остаётся на сайте по тарифу Базовый. Нужно ещё людей? Продлите Про." : "Вакансия уже закрыта.");
  const keyboard = boost && j.status === "approved" ? [[boostButton(j, offerFor(boost, j))]] : [];
  return { text, keyboard };
}

// Платное размещение (POST_PRICE, по умолчанию 900 ₸): вакансия или смена уходит на проверку только после
// оплаты. Без реквизитов Kaspi или с POST_PRICE = "0" размещение бесплатное, как раньше.
export const postPrice = (boost) => (boost && boost.postPrice > 0 ? boost.postPrice : 0);

// Цена размещения этой вакансии: «Про» (j.pro = 1) или «Базовый»
export const postPriceFor = (j, boost, now = new Date()) => (j.pro ? offerFor(boost, j, now).price : postPrice(boost));

export function postPayScreen(j, boost, now = new Date()) {
  const price = postPriceFor(j, boost, now);
  const what = j.kind === "shift" ? "смены" : "вакансии";
  return {
    text:
      `💳 <b>Размещение ${what} по тарифу ${j.pro ? "Про" : "Базовый"} за ${money(price)}</b>\n\n${card(j)}\n\n` +
      `Как оплатить: переведите <b>${money(price)}</b> на Kaspi\n${esc(boost.kaspi)}\n` +
      `В комментарии к переводу напишите «№${j.id}». Потом нажмите кнопку ниже: мы сверим перевод и отправим ` +
      `${j.kind === "shift" ? "смену" : "вакансию"} на проверку. Если не пропустим, деньги вернём.`,
    keyboard: [[{ text: "✅ Я оплатил", callback_data: `postpaid:${j.id}` }], [{ text: "Оплачу позже", callback_data: `postlater:${j.id}` }]],
  };
}

export function postWaitText(j) {
  return (
    `⏳ Сверяем перевод за размещение №${j.id} «${esc(j.title)}». Обычно это до пары часов днём. ` +
    "Как только деньги придут, отправим на проверку и напишу. Ваши вакансии: /myjobs"
  );
}

export function postLaterText(j) {
  return `Хорошо. ${j.kind === "shift" ? "Смена ждёт" : "Вакансия ждёт"} оплаты: оплатить можно в /myjobs, кнопка «💳 Оплатить №${j.id}».`;
}

export function postPaidText(j) {
  return (
    `💳 ${j.pro ? "Тариф Про оплачен" : "Оплата получена"}, спасибо! «${esc(j.title)}» на проверке, обычно это до часа. ` +
    "Напишу, когда опубликуем. Ваши вакансии: /myjobs"
  );
}

// «Срочно» для смены дешевле и действует до дня смены включительно (не меньше суток)
export function offerFor(boost, j, now = new Date()) {
  if (!boost || j.kind !== "shift" || !j.shift_date) return boost;
  const days = Math.max(1, Math.ceil((Date.parse(`${j.shift_date}T19:00:00Z`) - now.getTime()) / 86400e3));
  return { ...boost, price: boost.shiftPrice, days, shift: true };
}

// «1 вакансия», «3 вакансии», «10 вакансий»
export function vacancies(n) {
  const d = n % 10, h = n % 100;
  return d === 1 && h !== 11 ? "вакансия" : d >= 2 && d <= 4 && (h < 12 || h > 14) ? "вакансии" : "вакансий";
}

export const money = (n) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ₸`;
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
  const what = isBoosted(j, now) ? "Продлить Про" : "🔥 Про";
  return { text: `${what} №${j.id}: ${money(boost.price)}`, callback_data: `boost:${j.id}` };
}

export function boostScreen(j, boost, now = new Date(), channels = DEFAULT_CHANNELS, credits = 0) {
  boost = offerFor(boost, j, now);
  const chat = (channels || DEFAULT_CHANNELS)[j.city];
  const channel = chat ? `\n2. Пост в нашем канале ${chat} (${CITY[j.city]}) с той же пометкой, закреплённый наверху канала на все ${boost.days} дней.` : "";
  return {
    text:
      (boost.shift ? `🔥 <b>Тариф Про до начала смены за ${money(boost.price)}</b>\n\n${card(j)}\n\n`
        : `🔥 <b>Тариф Про на ${boost.days} дней за ${money(boost.price)}</b>\n\n${card(j)}\n\n`) +
      `1. Вакансия первой в списке города на vacante.kz с пометкой «🔥 Срочно».${channel}` +
      (boost.shift || !chat ? "" : "\n3. Повторный пост в канале через неделю, в конце итог по откликам.") + "\n\n" +
      `Как оплатить: переведите <b>${money(boost.price)}</b> на Kaspi\n${esc(boost.kaspi)}\n` +
      `В комментарии к переводу напишите «№${j.id}». Потом нажмите кнопку ниже: мы сверим перевод и поднимем вакансию.`,
    keyboard: [
      [{ text: "✅ Я оплатил", callback_data: `paid:${j.id}` }],
      ...(credits > 0 && !boost.shift ? [[{ text: `🔥 Списать из пакета, осталось ${credits}`, callback_data: `usecredit:${j.id}` }]] : []),
    ],
  };
}

export const PAYMENT_STATUS = { pending: "ждёт проверки", confirmed: "подтверждена", rejected: "не найдена" };

// Карточка оплаты у модераторов: пока ждёт, с кнопками, потом с решением
export function paymentScreen(p, j) {
  const pack = p.kind === "pack";
  const what = pack ? `Оплата пакета «${p.pack} Про»` : p.kind === "post" ? (j.pro ? "Оплата размещения Про" : "Оплата размещения") : "Оплата Про";
  const head =
    `💳 ${what} №${p.id}: <b>${money(p.amount)}</b>${p.kind === "post" && !j.pro ? "" : ` на ${p.days} дней`}\n` +
    (pack ? `От: ${esc(j.employer_name)}\n\n` : `Вакансия №${j.id} «${esc(j.title)}», ${esc(j.company)}\nОт: ${esc(j.employer_name)}\n\n`);
  if (p.status !== "pending") {
    const by = p.decided_by ? `: ${esc(p.decided_by)}` : "";
    return { text: head + (p.status === "confirmed" ? `✅ Деньги пришли${by}` : `❌ Перевод не найден${by}`), keyboard: [] };
  }
  return {
    text: head + `Проверьте в Kaspi перевод на ${money(p.amount)} с комментарием «${pack ? `Пакет ${p.pack}` : `№${j.id}`}».`,
    keyboard: [[
      { text: "✅ Деньги пришли", callback_data: `pay:ok:${p.id}` },
      { text: "❌ Не пришли", callback_data: `pay:no:${p.id}` },
    ]],
  };
}

export function paymentWaitText(j) {
  return `⏳ Сверяем перевод за вакансию №${j.id} «${esc(j.title)}». Обычно это до пары часов днём. Напишу, как только поднимем.`;
}

export function boostedText(j, channels = DEFAULT_CHANNELS) {
  const chat = (channels || DEFAULT_CHANNELS)[j.city];
  return (
    `🔥 Тариф Про включён! Вакансия «${esc(j.title)}» отмечена «🔥 Срочно» до ${localDate(j.boost_until)}: ` +
    "через несколько минут она будет первой в списке своего города на vacante.kz." +
    (chat ? ` А в нашем канале ${chat} выйдет пост, закреплённый до конца срока.` : "") +
    "\n\nВаши вакансии: /myjobs"
  );
}

export function paymentRejectedText(j, kind = "boost") {
  return (
    `Мы не нашли перевод за ${kind === "post" ? "размещение" : "вакансию"} №${j.id} «${esc(j.title)}». ` +
    "Если вы уже переводили, проверьте сумму и комментарий и нажмите «Я оплатил» ещё раз: /myjobs"
  );
}

export const ADMIN_STATUSES = ["creator", "administrator"];

// Соискатель открыл анкету работодателя и нажал «Я ищу работу»: ведём его к вакансиям
export function seekerScreen(siteUrl, kind = "vacancy") {
  const what = kind === "shift" ? "смены и подработку" : "вакансии";
  return {
    text:
      "Понял! Эта анкета для работодателей, которые ищут сотрудников.\n\n" +
      `Чтобы найти работу, листайте ${what} в приложении, а новые вакансии по вашему городу я могу присылать сюда.`,
    keyboard: [
      [{ text: "🃏 Смотреть вакансии", web_app: { url: `${siteUrl}/app/` } }],
      [{ text: "🔔 Присылать новые вакансии", callback_data: "settings" }],
    ],
  };
}

// Напоминание о брошенной анкете: один раз, через час
export const NUDGE_AFTER_MIN = 60;
export const NUDGE_HOURS = [9, 21]; // по времени Казахстана, ночью не пишем

export function nudgeScreen(job) {
  const steps = stepsFor(job);
  const i = steps.findIndex((s) => s.field === job.step);
  const what = job.kind === "shift" ? "смену" : "вакансию";
  const title = job.title ? ` «${esc(job.title)}»` : "";
  const left = i >= 0 ? ` Осталось ${steps.length - i} из ${steps.length} вопросов, это пара минут.` : "";
  return {
    text: `Вы начали размещать ${what}${title}, но не закончили.${left}\n\nПродолжим с того же места?`,
    keyboard: [[{ text: "▶️ Продолжить", callback_data: `jobresume:${job.id}` }, { text: "Не нужно", callback_data: `jobdrop:${job.id}` }]],
  };
}

// Размещение вакансии целиком на сайте и в приложении (форма app/src/employer/PostForm.tsx), без анкеты в чате.
//   GET  /api/post  — открыто всем: города, частые должности, лимиты полей, тарифы
//   POST /api/post  — открыто всем: { action: "parse", text } (текст или ссылка → поля) и { action: "tidy", fields }
// Черновик и отправка идут через кабинет (cabinet.js, нужен вход): действия save и submit ниже.
// Отправка та же, что у кнопок бота (posting.submitDraft): платный тариф ставит вакансию в «ждёт оплаты»,
// на проверку она уходит только после подтверждения перевода.
// Воронка формы (form_events, миграция 0015): с каждым запросом приложение передаёт метки from и via (в адресе GET,
// в теле POST), а бот считает шаги open, parse, tidy, draft и submit числами за день. Кто именно открыл форму, не пишем.
import options from "./options.json" with { type: "json" };
import * as job from "./employer.js";
import { fetchPasted, parseVacancy, pasteUrl } from "./paste.js";
import { newDraft, submitDraft } from "./posting.js";
import { send, screen } from "./telegram.js";
import { FIELD_NAMES, tidyJob } from "./tidy.js";

const CITIES = new Set(options.cities.map(([slug]) => slug));
const STEP = Object.fromEntries(job.STEPS.map((s) => [s.field, s]));
export const LIMITS = Object.fromEntries(job.STEPS.filter((s) => s.max).map((s) => [s.field, s.max]));
const REQUIRED = job.STEPS.filter((s) => !s.optional).map((s) => s.field);

/** Поля из формы → поля вакансии: только известные, обрезанные по лимиту, город из списка. */
export function formFields(input = {}) {
  const out = {};
  for (const field of Object.keys(STEP)) {
    const raw = input[field];
    if (raw == null) continue;
    const v = String(raw).replace(/\r/g, "").trim();
    if (field === "city") {
      if (CITIES.has(v)) out.city = v;
      continue;
    }
    out[field] = v.slice(0, STEP[field].max);
  }
  return out;
}

/** Чего не хватает для отправки: ["title", "salary"]. */
export const missing = (fields) => REQUIRED.filter((f) => !fields[f]);

/** Текст или ссылка → поля формы, уже поправленные. */
export async function parseForForm(text) {
  const url = pasteUrl(text);
  if (url?.kind === "other") return { error: "Эту ссылку открыть не можем. Вставьте текст вакансии или ссылку на hh.kz или пост в Telegram-канале." };
  const found = url ? await fetchPasted(url) : parseVacancy(text);
  if (!found || !Object.keys(found).length) {
    return { error: url ? "Не получилось открыть ссылку. Скопируйте текст вакансии и вставьте его сюда." : "Не нашли в тексте вакансии. Вставьте объявление целиком." };
  }
  const { job: fields } = tidyJob(formFields(found));
  return { fields, found: Object.keys(fields) };
}

export function tidyForForm(input) {
  const { job: fields, changed } = tidyJob(formFields(input));
  return { fields, changed, changed_names: changed.map((f) => FIELD_NAMES[f]) };
}

export function postInfo(env) {
  const boost = job.boostOffer(env);
  const post = job.postPrice(boost);
  return {
    cities: options.cities,
    titles: job.TITLE_CHOICES.vacancy,
    limits: LIMITS,
    required: REQUIRED,
    tariffs: post ? { post, pro: boost.price, days: boost.days, packs: boost.packs } : null,
    bot: job.BOT_USERNAME,
  };
}

// Метки формы приходят в запросе без входа, прислать любую может кто угодно. В воронку и в jobs.came_from идут
// только свои: кнопки сайта и приложения (from) и источники визита, которые определяет сайт (via, static/via.js),
// остальные как other. Так число строк form_events за день ограничено, сколько бы меток ни выдумали
export const FORM_FROM = ["land", "site_header", "site_footer", "site_list", "site", "miniapp", "cabinet"];
export const FORM_VIAS = ["direct", "other", "google", "yandex", "bing", "ddg", "chatgpt", "perplex", "gemini", "copilot",
  "claude", "tg", "ig", "2gis"];
const known = (list, value) => (typeof value !== "string" || !value ? "" : list.includes(value) ? value : "other");

/**
 * Метки запроса формы для воронки. from — с какой кнопки пришли: в базе web_<from> или web, то же потом в jobs.came_from.
 * via — источник визита на сайт (google, chatgpt, tg, direct…): его считает сайт и дописывает к ссылке на форму,
 * '' если неизвестен. Незнакомые метки — other. given — запрос назвал хотя бы одну метку.
 * steps — шаги воронки за этот запрос, их пишет countForm.
 */
export function formLabels(from, via) {
  const button = known(FORM_FROM, from);
  return { cameFrom: button ? `web_${button}` : "web", via: known(FORM_VIAS, via), given: Boolean(from || via), steps: [] };
}

/**
 * Пишет шаги формы за запрос в воронку (form_events): числа за день по меткам, о человеке и его устройстве ничего.
 * Одна запись в D1 на запрос и в фоне: ответ её не ждёт, а ошибка счётчика запрос не роняет.
 */
export function countForm(env, ctx, form) {
  if (!form.steps.length) return;
  const written = writeSteps(env, form);
  ctx?.waitUntil(written);
}

async function writeSteps(env, { cameFrom, via, steps }) {
  try {
    await env.DB.prepare(
      `INSERT INTO form_events (day, came_from, via, step, n) VALUES ${steps.map(() => "(date('now', '+5 hours'), ?, ?, ?, 1)").join(", ")}
       ON CONFLICT(day, came_from, via, step) DO UPDATE SET n = n + 1`,
    ).bind(...steps.flatMap((step) => [cameFrom, via, step])).run();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
  }
}

// С одного адреса в минуту пишем не больше стольких шагов открытой части формы. Память своя у каждого экземпляра
// воркера, поэтому предел приблизительный, но поток запросов с одного адреса квоту записей D1 не съест
export const OPEN_STEPS_PER_MINUTE = 20;
const recent = new Map();
function mayCount(request, now = Date.now()) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const hit = recent.get(ip);
  if (!hit || now - hit.start >= 60_000) {
    if (recent.size > 5000) recent.clear();
    recent.set(ip, { start: now, n: 1 });
    return true;
  }
  hit.n += 1;
  return hit.n <= OPEN_STEPS_PER_MINUTE;
}

// Шаг открытой части формы: open, parse или tidy. Не считаем запрос без from и via (роботы и старая сборка
// приложения), не со страниц сайта и приложения (нет разрешённого Origin, его ставит браузер) и сверх предела минуты
function countStep(env, ctx, form, step, request, headers) {
  if (!form.given || !headers["Access-Control-Allow-Origin"] || !mayCount(request)) return;
  form.steps.push(step);
  countForm(env, ctx, form);
}

export async function postApi(request, env, headers, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method === "GET") {
    const query = new URL(request.url).searchParams;
    countStep(env, ctx, formLabels(query.get("from"), query.get("via")), "open", request, headers);
    return Response.json(postInfo(env), { headers });
  }
  if (request.method !== "POST") return Response.json({ error: "method" }, { status: 405, headers });
  const body = await request.json().catch(() => ({}));
  const form = formLabels(body.from, body.via);
  if (body.action === "parse") {
    const text = String(body.text ?? "").trim().slice(0, 4000);
    if (text.length < 10) return Response.json({ error: "Вставьте текст вакансии целиком или ссылку на неё" }, { status: 400, headers });
    const r = await parseForForm(text);
    if (!r.error) countStep(env, ctx, form, "parse", request, headers);
    return Response.json(r, { status: r.error ? 400 : 200, headers });
  }
  if (body.action === "tidy") {
    const r = tidyForForm(body.fields || {});
    countStep(env, ctx, form, "tidy", request, headers);
    return Response.json(r, { headers });
  }
  return Response.json({ error: "Неизвестное действие" }, { status: 400, headers });
}

// Черновик с сайта: последний черновик вакансии этого работодателя (начатый и в боте тоже)
export function currentDraft(env, chatId) {
  return env.DB.prepare("SELECT * FROM jobs WHERE employer_chat = ? AND status = 'draft' AND kind = 'vacancy' ORDER BY id DESC LIMIT 1")
    .bind(chatId).first();
}

export const draftView = (d) => (d ? { id: d.id, ...Object.fromEntries(Object.keys(STEP).map((f) => [f, d[f] ?? ""])) } : null);

/** Сохраняет поля формы в черновик (создаёт, если его нет). form — метки запроса (formLabels). → { draft } или { error } */
export async function saveDraft(env, user, input, form) {
  const fields = formFields(input);
  let draft = await currentDraft(env, user.id);
  if (!draft) {
    const created = await newDraft(env, user.id, user, "vacancy", form.cameFrom);
    if (created.error) return created;
    form.steps.push("draft");  // черновик завела форма: шаг воронки
    draft = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(created.id).first();
  }
  const next = { ...draft };
  for (const field of Object.keys(STEP)) if (field in fields) next[field] = fields[field] === "" ? null : fields[field];
  // Бот продолжит с того же места, если работодатель вернётся в чат
  const step = job.nextStep(next);
  await env.DB.prepare(
    `UPDATE jobs SET step = ?, city = ?, title = ?, company = ?, salary = ?, schedule = ?, address = ?, details = ?,
       updated_at = datetime('now') WHERE id = ? AND status = 'draft'`,
  ).bind(step ? step.field : null, next.city, next.title, next.company, next.salary, next.schedule, next.address, next.details, draft.id).run();
  return { draft: { ...next, step: step ? step.field : null } };
}

const TARIFFS = ["basic", "pro", "credit", "free"];

/** Отправка формы: сохранить, поправить текст, выбрать тариф. Копию бот пишет в чат, там же потом отклики. */
export async function submitForm(env, user, input, tariff, form, ctx) {
  if (!TARIFFS.includes(tariff)) return { error: "Выберите тариф" };
  const saved = await saveDraft(env, user, input, form);
  if (saved.error) return saved;
  const lack = missing(saved.draft);
  if (lack.length) return { error: `Заполните: ${lack.map((f) => (f === "city" ? "город" : FIELD_NAMES[f])).join(", ")}` };
  const { job: tidied } = tidyJob(saved.draft);
  for (const step of job.STEPS) if (step.optional && !tidied[step.field]) tidied[step.field] = "";
  await env.DB.prepare(
    "UPDATE jobs SET step = NULL, title = ?, company = ?, salary = ?, schedule = ?, address = ?, details = ? WHERE id = ?",
  ).bind(tidied.title, tidied.company, tidied.salary, tidied.schedule, tidied.address, tidied.details, tidied.id).run();
  const r = await submitDraft(env, user.id, { ...tidied, step: null }, tariff, ctx);
  if (r.error) return r;
  form.steps.push("submit");  // ушла на оплату или на проверку: шаг воронки
  if (r.outcome === "payment") {
    // В чате те же реквизиты и «Я оплатил»: можно оплатить и оттуда
    await send(env, user.id, ...screen(job.postPayScreen(r.job, job.boostOffer(env))));
    return { message: "Вакансия сохранена. Осталось оплатить: реквизиты ниже", submitted: r.job.id, outcome: "payment" };
  }
  await send(env, user.id, `${job.card(r.job)}\n\n⏳ Вакансия с сайта на проверке, обычно это до часа. Напишу, когда опубликуем. Отклики придут сюда.`);
  return { message: "Отправили на проверку, обычно это до часа", submitted: r.job.id, outcome: "pending" };
}

// Размещение вакансии целиком на сайте и в приложении (форма app/src/employer/PostForm.tsx), без анкеты в чате.
//   GET  /api/post  — открыто всем: города, частые должности, лимиты полей, тарифы
//   POST /api/post  — открыто всем: { action: "parse", text } (текст или ссылка → поля) и { action: "tidy", fields }
// Черновик и отправка идут через кабинет (cabinet.js, нужен вход): действия save и submit ниже.
// Отправка та же, что у кнопок бота (posting.submitDraft): платный тариф ставит вакансию в «ждёт оплаты»,
// на проверку она уходит только после подтверждения перевода.
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

export async function postApi(request, env, headers) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method === "GET") return Response.json(postInfo(env), { headers });
  if (request.method !== "POST") return Response.json({ error: "method" }, { status: 405, headers });
  const body = await request.json().catch(() => ({}));
  if (body.action === "parse") {
    const text = String(body.text ?? "").trim().slice(0, 4000);
    if (text.length < 10) return Response.json({ error: "Вставьте текст вакансии целиком или ссылку на неё" }, { status: 400, headers });
    const r = await parseForForm(text);
    return Response.json(r, { status: r.error ? 400 : 200, headers });
  }
  if (body.action === "tidy") return Response.json(tidyForForm(body.fields || {}), { headers });
  return Response.json({ error: "Неизвестное действие" }, { status: 400, headers });
}

// Черновик с сайта: последний черновик вакансии этого работодателя (начатый и в боте тоже)
export function currentDraft(env, chatId) {
  return env.DB.prepare("SELECT * FROM jobs WHERE employer_chat = ? AND status = 'draft' AND kind = 'vacancy' ORDER BY id DESC LIMIT 1")
    .bind(chatId).first();
}

export const draftView = (d) => (d ? { id: d.id, ...Object.fromEntries(Object.keys(STEP).map((f) => [f, d[f] ?? ""])) } : null);

const CAME_FROM = /^[a-z_]{1,20}$/;

/** Сохраняет поля формы в черновик (создаёт, если его нет). → { draft } или { error } */
export async function saveDraft(env, user, input, from) {
  const fields = formFields(input);
  let draft = await currentDraft(env, user.id);
  if (!draft) {
    const created = await newDraft(env, user.id, user, "vacancy", CAME_FROM.test(from || "") ? `web_${from}`.slice(0, 24) : "web");
    if (created.error) return created;
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
export async function submitForm(env, user, input, tariff, from, ctx) {
  if (!TARIFFS.includes(tariff)) return { error: "Выберите тариф" };
  const saved = await saveDraft(env, user, input, from);
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
  if (r.outcome === "payment") {
    // В чате те же реквизиты и «Я оплатил»: можно оплатить и оттуда
    await send(env, user.id, ...screen(job.postPayScreen(r.job, job.boostOffer(env))));
    return { message: "Вакансия сохранена. Осталось оплатить: реквизиты ниже", submitted: r.job.id, outcome: "payment" };
  }
  await send(env, user.id, `${job.card(r.job)}\n\n⏳ Вакансия с сайта на проверке, обычно это до часа. Напишу, когда опубликуем. Отклики придут сюда.`);
  return { message: "Отправили на проверку, обычно это до часа", submitted: r.job.id, outcome: "pending" };
}

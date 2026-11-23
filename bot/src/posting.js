// Работодатель размещает вакансию или смену: анкета, предпросмотр, отправка на проверку, закрытие.
import { creditsLeft, endDialog, getJob, myJobs, setDialog, useCredit } from "./db.js";
import { fetchPasted, findCity, looksPasted, parseVacancy, pasteUrl } from "./paste.js";
import * as job from "./employer.js";
import { sendNotice, wakeSite } from "./notices.js";
import * as shift from "./shift.js";
import { FIELD_NAMES, tidyJob } from "./tidy.js";
import { answerCallback, edit, screen, send, tg } from "./telegram.js";
import { HELP } from "./texts.js";

const postIntro = (price) =>
  `Разместим вакансию${price ? ` за ${job.money(price)}` : ""}: на vacante.kz, в приложении, в подборках подписчикам бота ` +
  "и в Telegram-канале вашего города. " +
  "Отклики кандидатов придут вам сюда. Ответьте на несколько вопросов, это пара минут.";

const PASTE_HINT = "⚡ Быстрее: вставьте сюда текст вакансии или ссылку на неё (hh.kz, пост в Telegram-канале), я сам заполню анкету.";

// Новый черновик вместо старого. Возвращает id черновика или текст ошибки.
export async function newDraft(env, chatId, from, kind, cameFrom) {
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE employer_chat = ? AND status IN ('pending', 'payment')")
    .bind(chatId)
    .first("n");
  if (pending >= job.MAX_PENDING) {
    return { error: `У вас уже ${pending} вакансии ждут оплаты или проверки. Оплатите или закройте их: /myjobs` };
  }
  await env.DB.prepare("DELETE FROM jobs WHERE employer_chat = ? AND status = 'draft'").bind(chatId).run();
  const { meta } = await env.DB.prepare(
    "INSERT INTO jobs (employer_chat, employer_name, step, kind, came_from) VALUES (?, ?, 'city', ?, ?)",
  )
    .bind(chatId, job.employerName(from), kind, cameFrom)
    .run();
  await setDialog(env, chatId, "post", meta.last_row_id);
  return { id: meta.last_row_id };
}

export async function startPost(env, m, kind = "vacancy", cameFrom = null) {
  const chatId = m.chat.id;
  const created = await newDraft(env, chatId, m.from, kind, cameFrom);
  if (created.error) return send(env, chatId, created.error);
  const { text, keyboard } = job.askScreen(job.stepsFor({ kind })[0]);
  const price = await postPriceFor(env, chatId);
  // Из меню работодателя: про размещение там уже рассказали, сразу к делу
  const intro = cameFrom === "menu" ? "" : `${kind === "shift" ? shift.shiftIntro(price) : postIntro(price)}\n\n`;
  return send(env, chatId, `${intro}${PASTE_HINT}\n\n${text}`, keyboard);
}

// Поля из вставленного текста, которые можно взять в анкету этого вида
const PASTE_FIELDS = { vacancy: ["city", "title", "company", "salary", "schedule", "address", "details"],
  shift: ["city", "title", "company", "salary", "address", "details"] };

/** Разбирает вставленный текст или ссылку в черновик. → { draft } или { error } */
export async function pasteInto(env, draft, text) {
  const url = pasteUrl(text);
  if (url?.kind === "other") return { error: "Эту ссылку открыть не могу. Вставьте текст вакансии сообщением или ответьте на вопрос." };
  const found = url ? await fetchPasted(url) : parseVacancy(text);
  if (!found || !Object.keys(found).length) {
    return { error: url ? "Не получилось открыть ссылку. Вставьте текст вакансии сообщением или ответьте на вопрос." : null };
  }
  const next = { ...draft };
  for (const field of PASTE_FIELDS[draft.kind === "shift" ? "shift" : "vacancy"]) {
    if (next[field] == null && found[field]) next[field] = found[field];
  }
  // Необязательное, чего в тексте не нашлось, не спрашиваем: всё видно в предпросмотре
  for (const step of job.stepsFor(draft)) if (step.optional && next[step.field] == null) next[step.field] = "";
  return { draft: next, found: Object.keys(found).length };
}

const PASTED = "✍️ Заполнил анкету из вашего текста. Осталось ответить на пару вопросов, а в конце проверить карточку.";

/** Кабинет в приложении: вакансия из вставленного текста, дальше анкета в чате с ботом. */
export async function pasteFromApp(env, user, text) {
  const chatId = user.id;
  // Сначала разбираем: если не вышло, начатая в боте анкета остаётся как была
  const r = await pasteInto(env, { ...job.newJob("vacancy"), kind: "vacancy" }, text);
  if (!r.draft) return { error: r.error || "Не нашёл в тексте вакансии. Вставьте объявление целиком или разместите через бота" };
  const created = await newDraft(env, chatId, user, "vacancy", "app");
  if (created.error) return created;
  const sent = await advance(env, chatId, { ...r.draft, id: created.id }, undefined, PASTED);
  if (sent && sent.ok === false) return { error: "Не получилось написать вам в Telegram. Откройте бота @vacantekz_bot и нажмите «Старт»" };
  return { message: "Готово! Анкета заполнена, проверьте её в чате с ботом", draft: created.id };
}

// Цена размещения. Одна для всех: модераторы (админы каналов) тоже видят тарифы и оплату, как работодатели,
// а бесплатно размещают только отдельной кнопкой «🛡 Без оплаты» (раньше им всё было бесплатно молча,
// и проверка пути работодателя выглядела как публикация без оплаты).
async function postPriceFor(env) {
  return job.postPrice(job.boostOffer(env));
}

export async function isAdmin(env, chatId) {
  return !!(await env.DB.prepare("SELECT chat_id FROM admins WHERE chat_id = ?").bind(chatId).first());
}

// Меню работодателя: /employer, ?start=employer и кнопка «🏢 Ищу сотрудников» на /start
export async function employerMenu(env, chatId, messageId) {
  const { text, keyboard } = job.employerMenu(await postPriceFor(env, chatId), job.boostOffer(env), env.SITE_URL);
  return messageId ? edit(env, chatId, messageId, text, keyboard) : send(env, chatId, text, keyboard);
}

// Кнопки меню работодателя. Профиль компании ведёт сервер: передаём ему команду /company от имени работодателя.
export async function employerButton(env, q, relay) {
  const chatId = q.message.chat.id;
  const m = { message_id: q.message.message_id, chat: q.message.chat, from: q.from, date: Math.floor(Date.now() / 1000) };
  const action = q.data.split(":")[1];
  await answerCallback(env, q);
  if (!action) return employerMenu(env, chatId);
  if (action === "vacancy") return startPost(env, m, "vacancy", "menu");
  if (action === "shift") return startPost(env, m, "shift", "menu");
  if (action === "jobs") return send(env, chatId, ...screen(job.myJobsScreen(await myJobs(env, chatId), job.boostOffer(env))));
  if (action === "company") {
    await endDialog(env, chatId);
    if (await relay({ message: { ...m, text: "/company" } })) return;
    return send(env, chatId, "Профиль компании сейчас недоступен, попробуйте через несколько минут: /company");
  }
}

// «📩 Отклики №12» в /myjobs: бот заново присылает сообщения с откликами этой вакансии, последние 20
const SHOW_APPLICATIONS = 20;

export async function showApplications(env, q) {
  const found = await getJob(env, Number(q.data.split(":")[1]));
  if (!found || found.employer_chat !== q.message.chat.id) return answerCallback(env, q, "Вакансия не найдена: /myjobs");
  await answerCallback(env, q);
  return resendApplications(env, q.message.chat.id, found.id);
}

/** Присылает в чат работодателя отклики на его вакансию ещё раз. Для кнопки в /myjobs и кабинета в приложении. */
export async function resendApplications(env, chatId, jobId) {
  const found = await getJob(env, jobId);
  if (!found || found.employer_chat !== chatId) return { error: "Вакансия не найдена: /myjobs" };
  const { results } = await env.DB.prepare(
    "SELECT notice_id FROM applications WHERE job_id = ? ORDER BY id DESC",
  ).bind(found.id).all();
  const ids = results.map((r) => r.notice_id).filter(Boolean).slice(0, SHOW_APPLICATIONS).reverse();
  await send(env, chatId, job.applicationsIntro(found, ids.length, results.length));
  for (const id of ids) await tg(env, "copyMessage", { chat_id: chatId, from_chat_id: chatId, message_id: id });
  return { shown: ids.length, total: results.length };
}

// Предпросмотр с выбором тарифа: Базовый, Про и Про из пакета (модератору ещё «Без оплаты»)
async function preview(env, chatId, draft, note = "") {
  const price = await postPriceFor(env, chatId);
  const screen = job.previewScreen(draft, price, price ? job.boostOffer(env) : null, price ? await creditsLeft(env, chatId) : 0,
    new Date(), price ? await isAdmin(env, chatId) : false);
  return note ? { ...screen, text: `${note}\n\n${screen.text}` } : screen;
}

// «✨ Поправили оформление: зарплата, график»: что изменил tidy.js перед предпросмотром
export const tidiedNote = (changed) =>
  changed.length ? `✨ Поправили оформление: ${changed.map((f) => FIELD_NAMES[f]).join(", ")}. Если что-то не так, нажмите «Заполнить заново».` : "";

export async function postAnswer(env, m, d) {
  const chatId = m.chat.id;
  const draft = await getJob(env, d.job_id);
  if (!draft || draft.status !== "draft") {
    await endDialog(env, chatId);
    return send(env, chatId, HELP);
  }
  if (!draft.step) return send(env, chatId, ...screen(await preview(env, chatId, draft))); // анкета заполнена, ждём кнопку
  const text = m.text || m.caption || "";
  // В начале анкеты можно вставить объявление целиком или ссылку на него
  if ((draft.step === "city" || draft.step === "title") && looksPasted(text)) {
    const r = await pasteInto(env, draft, text);
    // На вопросе «Кого ищете?» длинная должность — обычный ответ, если разбор её не нашёл
    if (r.draft && (draft.step !== "title" || r.draft.title)) return advance(env, chatId, r.draft, undefined, PASTED);
    if (r.error) return send(env, chatId, r.error, job.askScreen(job.stepsFor(draft).find((s) => s.field === draft.step)).keyboard);
  }
  // Город словами вместо кнопки: «Алматы», «в Астане»
  if (draft.step === "city" && findCity(text)) return advance(env, chatId, { ...draft, city: findCity(text) });
  const { job: next, error } = job.answer(draft, draft.step, text);
  if (error) return send(env, chatId, error, job.askScreen(job.stepsFor(draft).find((s) => s.field === draft.step)).keyboard);
  return advance(env, chatId, next);
}

export async function postButton(env, q, ctx) {
  const chatId = q.message.chat.id;
  const messageId = q.message.message_id;
  const d = await env.DB.prepare("SELECT * FROM dialogs WHERE chat_id = ? AND mode = 'post'").bind(chatId).first();
  const draft = d && (await getJob(env, d.job_id));
  if (!draft || draft.status !== "draft") return answerCallback(env, q, "Анкета уже закрыта. Новая вакансия: /vacancy");
  await answerCallback(env, q);
  if (q.data === "jobseeker") {
    // Анкету открыл соискатель: черновик убираем, считаем и показываем, где искать работу
    await env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(draft.id).run();
    await endDialog(env, chatId);
    await env.DB.prepare(
      `INSERT INTO role_switches (day, came_from, n) VALUES (date('now', '+5 hours'), ?, 1)
       ON CONFLICT(day, came_from) DO UPDATE SET n = n + 1`,
    ).bind(draft.came_from || "").run();
    return edit(env, chatId, messageId, ...screen(job.seekerScreen(env.SITE_URL, draft.kind)));
  }
  if (q.data === "jobcancel") {
    await env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(draft.id).run();
    await endDialog(env, chatId);
    return edit(env, chatId, messageId, "Отменили. Разместить вакансию заново: /vacancy");
  }
  if (q.data === "jobsend") return draft.step ? null : submit(env, chatId, messageId, draft, ctx);
  if (q.data === "jobfree") return draft.step ? null : submit(env, chatId, messageId, draft, ctx, "free");
  if (q.data === "jobpro") return draft.step ? null : submit(env, chatId, messageId, draft, ctx, "pro");
  if (q.data === "jobcredit") return draft.step ? null : submit(env, chatId, messageId, draft, ctx, "credit");
  const next = job.pressed(draft, q.data);
  return next && advance(env, chatId, next, messageId);
}

// Следующий вопрос анкеты или, когда всё заполнено, предпросмотр. По кнопке правим то же сообщение.
async function advance(env, chatId, draft, messageId, note) {
  const step = job.nextStep(draft);
  draft = { ...draft, step: step ? step.field : null };
  // Анкета заполнена: сразу приводим текст в порядок, в предпросмотре работодатель видит уже аккуратный вариант
  let tidied = "";
  if (!step) {
    const t = tidyJob(draft);
    draft = t.job;
    tidied = tidiedNote(t.changed);
  }
  // У смены график — это её день и время: «Смена 07.11, 10:00–22:00»
  if (draft.kind === "shift") draft.schedule = draft.shift_date && draft.shift_start ? shift.scheduleText(draft) : null;
  await env.DB.prepare(
    `UPDATE jobs SET step = ?, city = ?, title = ?, company = ?, salary = ?, schedule = ?, address = ?, details = ?,
       shift_date = ?, shift_start = ?, shift_end = ?, need = ?, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(draft.step, draft.city, draft.title, draft.company, draft.salary, draft.schedule, draft.address, draft.details,
      draft.shift_date ?? null, draft.shift_start ?? null, draft.shift_end ?? null, draft.need ?? null, draft.id)
    .run();
  const { text: body, keyboard } = step ? job.askScreen(step) : await preview(env, chatId, draft, tidied);
  const text = note ? `${note}\n\n${body}` : body;
  return messageId ? edit(env, chatId, messageId, text, keyboard) : send(env, chatId, text, keyboard);
}

// tariff: basic (Базовый), pro (Про с оплатой сразу за размещение и подъём), credit (Про из пакета)
// или free (только модератору: без оплаты). Возвращает { job, outcome: payment | pending } или { error }.
// Общая для кнопок бота и формы на сайте (webSubmit).
export async function submitDraft(env, chatId, draft, tariff = "basic", ctx) {
  const boost = job.boostOffer(env);
  const price = await postPriceFor(env);
  if (tariff === "credit") {
    // Про из пакета: без оплаты, срок Про считаем с этой минуты (проверка обычно до часа)
    if (draft.kind === "shift" || !price || !boost) return { error: "Про из пакета сейчас недоступен" };
    if (!(await useCredit(env, chatId))) return { error: "В пакетах не осталось Про" };
    await env.DB.prepare(
      `UPDATE jobs SET status = 'pending', step = NULL, pro = 1, boost_until = datetime('now', '+' || ? || ' days'),
         updated_at = datetime('now') WHERE id = ?`,
    ).bind(boost.days, draft.id).run();
    await endDialog(env, chatId);
    const saved = { ...draft, status: "pending", pro: 1 };
    await notifyModerators(env, saved, ctx);
    return { job: saved, outcome: "pending", credits: await creditsLeft(env, chatId) };
  }
  if (tariff === "free" && !(price && (await isAdmin(env, chatId)))) return { error: "Без оплаты размещают только модераторы" };
  if (price && tariff !== "free") {
    // Платное размещение: сначала оплата, на проверку вакансия уйдёт только после подтверждения перевода
    const pro = tariff === "pro" && boost ? 1 : 0;
    await env.DB.prepare("UPDATE jobs SET status = 'payment', step = NULL, pro = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(pro, draft.id).run();
    await endDialog(env, chatId);
    wakeSite(env, ctx);  // агент-модератор оформит текст, пока работодатель платит (moderation.json)
    return { job: { ...draft, status: "payment", pro }, outcome: "payment" };
  }
  await env.DB.prepare("UPDATE jobs SET status = 'pending', step = NULL, updated_at = datetime('now') WHERE id = ?").bind(draft.id).run();
  await endDialog(env, chatId);
  const saved = { ...draft, status: "pending" };
  await notifyModerators(env, saved, ctx);
  return { job: saved, outcome: "pending" };
}

const SENT = "⏳ Отправили на проверку, обычно это до часа. Напишу, когда опубликуем. Ваши вакансии: /myjobs";

async function submit(env, chatId, messageId, draft, ctx, tariff = "basic") {
  const r = await submitDraft(env, chatId, draft, tariff, ctx);
  if (r.error) return edit(env, chatId, messageId, ...screen(await preview(env, chatId, draft)));
  if (r.outcome === "payment") return edit(env, chatId, messageId, ...screen(job.postPayScreen(r.job, job.boostOffer(env))));
  const extra = tariff === "credit" ? `🔥 Тариф Про из пакета, осталось: ${r.credits}.\n` : tariff === "free" ? "🛡 Без оплаты, как модератор.\n" : "";
  return edit(env, chatId, messageId, `${job.card(draft)}\n\n${extra}${SENT}`);
}

async function notifyModerators(env, found, ctx) {
  const { results } = await env.DB.prepare("SELECT chat_id FROM admins").all();
  for (const admin of results) await sendNotice(env, admin.chat_id, found);
  // Обновление сайта выкладывает и очередь на проверку (moderation.json в ветке data), её читает агент
  wakeSite(env, ctx);
}

export async function closeJob(env, q) {
  const chatId = q.message.chat.id;
  const closed = await closeOwnJob(env, chatId, Number(q.data.split(":")[1]));
  await answerCallback(env, q, closed ? "Вакансия закрыта, с сайта она уйдёт в течение часа" : undefined);
  const { text, keyboard } = job.myJobsScreen(await myJobs(env, chatId), job.boostOffer(env));
  return edit(env, chatId, q.message.message_id, text, keyboard);
}

/** Закрывает свою вакансию: true, если закрыли. */
export async function closeOwnJob(env, chatId, id) {
  const { meta } = await env.DB.prepare(
    `UPDATE jobs SET status = 'closed', updated_at = datetime('now')
     WHERE id = ? AND employer_chat = ? AND status IN ('payment', 'pending', 'approved')`,
  )
    .bind(id, chatId)
    .run();
  return meta.changes > 0;
}

// Платная услуга «🔥 Срочно»: работодатель переводит деньги на Kaspi и жмёт «Я оплатил»,
// модераторы получают карточку и подтверждают перевод кнопкой, после этого вакансия поднимается

// «▶️ Продолжить» и «Не нужно» под напоминанием о брошенной анкете
export async function resumeButton(env, q) {
  const chatId = q.message.chat.id;
  const [action, id] = q.data.split(":");
  const draft = await getJob(env, Number(id));
  if (!draft || draft.employer_chat !== chatId || draft.status !== "draft") {
    return answerCallback(env, q, "Анкета уже закрыта. Новая вакансия: /vacancy");
  }
  await answerCallback(env, q);
  if (action === "jobdrop") {
    await env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(draft.id).run();
    await endDialog(env, chatId);
    return edit(env, chatId, q.message.message_id, "Хорошо, убрал анкету. Если понадобятся сотрудники: /employer");
  }
  await setDialog(env, chatId, "post", draft.id);
  const step = job.nextStep(draft);
  const { text, keyboard } = step ? job.askScreen(step) : await preview(env, chatId, draft);
  return edit(env, chatId, q.message.message_id, text, keyboard);
}

/** Раз в час: тем, кто бросил анкету час–сутки назад после первого ответа, одно напоминание днём. */
export async function nudgeDrafts(env, now = new Date()) {
  const hour = (now.getUTCHours() + 5) % 24;
  if (hour < job.NUDGE_HOURS[0] || hour >= job.NUDGE_HOURS[1]) return 0;
  const at = (min) => new Date(now.getTime() - min * 60e3).toISOString().slice(0, 19).replace("T", " ");
  const { results } = await env.DB.prepare(
    `SELECT * FROM jobs WHERE status = 'draft' AND nudged = 0 AND step IS NOT NULL AND city IS NOT NULL
       AND updated_at <= ? AND updated_at >= ? ORDER BY id LIMIT 30`,
  ).bind(at(job.NUDGE_AFTER_MIN), at(24 * 60)).all();
  for (const draft of results) {
    await env.DB.prepare("UPDATE jobs SET nudged = 1 WHERE id = ?").bind(draft.id).run();
    await send(env, draft.employer_chat, ...screen(job.nudgeScreen(draft)));
  }
  return results.length;
}

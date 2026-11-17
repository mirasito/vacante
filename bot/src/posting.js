// Работодатель размещает вакансию или смену: анкета, предпросмотр, отправка на проверку, закрытие.
import { endDialog, getJob, myJobs, setDialog } from "./db.js";
import * as job from "./employer.js";
import { sendNotice, wakeSite } from "./notices.js";
import * as shift from "./shift.js";
import { answerCallback, edit, screen, send } from "./telegram.js";
import { HELP } from "./texts.js";

const postIntro = (price) =>
  `Разместим вакансию${price ? ` за ${job.money(price)}` : ""}: на vacante.kz, в приложении и в подборках подписчикам бота. ` +
  "Отклики кандидатов придут вам сюда. Ответьте на несколько вопросов, это пара минут.";

export async function startPost(env, m, kind = "vacancy", cameFrom = null) {
  const chatId = m.chat.id;
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE employer_chat = ? AND status IN ('pending', 'payment')")
    .bind(chatId)
    .first("n");
  if (pending >= job.MAX_PENDING) {
    return send(env, chatId, `У вас уже ${pending} вакансии ждут оплаты или проверки. Оплатите или закройте их: /myjobs`);
  }
  await env.DB.prepare("DELETE FROM jobs WHERE employer_chat = ? AND status = 'draft'").bind(chatId).run();
  const { meta } = await env.DB.prepare(
    "INSERT INTO jobs (employer_chat, employer_name, step, kind, came_from) VALUES (?, ?, 'city', ?, ?)",
  )
    .bind(chatId, job.employerName(m.from), kind, cameFrom)
    .run();
  await setDialog(env, chatId, "post", meta.last_row_id);
  const { text, keyboard } = job.askScreen(job.stepsFor({ kind })[0]);
  const price = await postPriceFor(env, chatId);
  return send(env, chatId, `${kind === "shift" ? shift.shiftIntro(price) : postIntro(price)}\n\n${text}`, keyboard);
}

// Цена размещения для этого работодателя: модераторы (админы каналов) размещают бесплатно
async function postPriceFor(env, chatId) {
  const price = job.postPrice(job.boostOffer(env));
  if (!price) return 0;
  const admin = await env.DB.prepare("SELECT chat_id FROM admins WHERE chat_id = ?").bind(chatId).first();
  return admin ? 0 : price;
}

export async function postAnswer(env, m, d) {
  const chatId = m.chat.id;
  const draft = await getJob(env, d.job_id);
  if (!draft || draft.status !== "draft") {
    await endDialog(env, chatId);
    return send(env, chatId, HELP);
  }
  if (!draft.step) return send(env, chatId, ...screen(job.previewScreen(draft, await postPriceFor(env, chatId)))); // анкета заполнена, ждём кнопку
  const { job: next, error } = job.answer(draft, draft.step, m.text);
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
  if (q.data === "jobcancel") {
    await env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(draft.id).run();
    await endDialog(env, chatId);
    return edit(env, chatId, messageId, "Отменили. Разместить вакансию заново: /vacancy");
  }
  if (q.data === "jobsend") return draft.step ? null : submit(env, chatId, messageId, draft, ctx);
  const next = job.pressed(draft, q.data);
  return next && advance(env, chatId, next, messageId);
}

// Следующий вопрос анкеты или, когда всё заполнено, предпросмотр. По кнопке правим то же сообщение.
async function advance(env, chatId, draft, messageId) {
  const step = job.nextStep(draft);
  draft = { ...draft, step: step ? step.field : null };
  // У смены график — это её день и время: «Смена 07.11, 10:00–22:00»
  if (draft.kind === "shift") draft.schedule = draft.shift_date && draft.shift_start ? shift.scheduleText(draft) : null;
  await env.DB.prepare(
    `UPDATE jobs SET step = ?, city = ?, title = ?, company = ?, salary = ?, schedule = ?, address = ?, details = ?,
       shift_date = ?, shift_start = ?, shift_end = ?, need = ?, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(draft.step, draft.city, draft.title, draft.company, draft.salary, draft.schedule, draft.address, draft.details,
      draft.shift_date ?? null, draft.shift_start ?? null, draft.shift_end ?? null, draft.need ?? null, draft.id)
    .run();
  const { text, keyboard } = step ? job.askScreen(step) : job.previewScreen(draft, await postPriceFor(env, chatId));
  return messageId ? edit(env, chatId, messageId, text, keyboard) : send(env, chatId, text, keyboard);
}

async function submit(env, chatId, messageId, draft, ctx) {
  if (await postPriceFor(env, chatId)) {
    // Платное размещение: сначала оплата, на проверку вакансия уйдёт после подтверждения перевода
    await env.DB.prepare("UPDATE jobs SET status = 'payment', updated_at = datetime('now') WHERE id = ?").bind(draft.id).run();
    await endDialog(env, chatId);
    return edit(env, chatId, messageId, ...screen(job.postPayScreen({ ...draft, status: "payment" }, job.boostOffer(env))));
  }
  await env.DB.prepare("UPDATE jobs SET status = 'pending', updated_at = datetime('now') WHERE id = ?").bind(draft.id).run();
  await endDialog(env, chatId);
  await edit(env, chatId, messageId, `${job.card(draft)}\n\n⏳ Отправили на проверку, обычно это до часа. Напишу, когда опубликуем. Ваши вакансии: /myjobs`);
  const { results } = await env.DB.prepare("SELECT chat_id FROM admins").all();
  for (const admin of results) await sendNotice(env, admin.chat_id, { ...draft, status: "pending" });
  // Обновление сайта выкладывает и очередь на проверку (moderation.json в ветке data), её читает агент
  wakeSite(env, ctx);
}

export async function closeJob(env, q) {
  const chatId = q.message.chat.id;
  const id = Number(q.data.split(":")[1]);
  const { meta } = await env.DB.prepare(
    `UPDATE jobs SET status = 'closed', updated_at = datetime('now')
     WHERE id = ? AND employer_chat = ? AND status IN ('payment', 'pending', 'approved')`,
  )
    .bind(id, chatId)
    .run();
  await answerCallback(env, q, meta.changes ? "Вакансия закрыта, с сайта она уйдёт в течение часа" : undefined);
  const { text, keyboard } = job.myJobsScreen(await myJobs(env, chatId), job.boostOffer(env));
  return edit(env, chatId, q.message.message_id, text, keyboard);
}

// Платная услуга «🔥 Срочно»: работодатель переводит деньги на Kaspi и жмёт «Я оплатил»,
// модераторы получают карточку и подтверждают перевод кнопкой, после этого вакансия поднимается

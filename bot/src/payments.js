// Оплаты на Kaspi: «🔥 Срочно» и платное размещение, подтверждение модератором.
import { getJob, getPayment } from "./db.js";
import * as job from "./employer.js";
import { sendNotice, wakeSite } from "./notices.js";
import { siteChannels } from "./site.js";
import { answerCallback, edit, screen, send } from "./telegram.js";

async function ownApproved(env, q) {
  const found = await getJob(env, Number(q.data.split(":")[1]));
  return found && found.employer_chat === q.message.chat.id && found.status === "approved" ? found : null;
}

export async function boostJob(env, q) {
  const boost = job.boostOffer(env);
  const found = boost && (await ownApproved(env, q));
  if (!found) return answerCallback(env, q, boost ? "Поднять можно только опубликованную вакансию" : "Услуга пока недоступна");
  await answerCallback(env, q);
  return send(env, q.message.chat.id, ...screen(job.boostScreen(found, boost, new Date(), await siteChannels(env))));
}

export async function paid(env, q) {
  const boost = job.boostOffer(env);
  const found = boost && (await ownApproved(env, q));
  if (!found) return answerCallback(env, q, boost ? "Вакансия уже закрыта" : "Услуга пока недоступна");
  const waiting = await env.DB.prepare("SELECT id FROM payments WHERE job_id = ? AND status = 'pending'").bind(found.id).first();
  if (waiting) return answerCallback(env, q, "Уже сверяем ваш перевод, напишу, как только поднимем");
  await answerCallback(env, q);
  const { meta } = await env.DB.prepare("INSERT INTO payments (job_id, employer_chat, amount, days) VALUES (?, ?, ?, ?)")
    .bind(found.id, found.employer_chat, job.offerFor(boost, found).price, job.offerFor(boost, found).days)
    .run();
  await edit(env, q.message.chat.id, q.message.message_id, job.paymentWaitText(found));
  await notifyPayment(env, await getPayment(env, meta.last_row_id), found);
}

// Карточка оплаты всем модераторам; запоминаем сообщения, чтобы обновить их после решения
async function notifyPayment(env, payment, found) {
  const { results } = await env.DB.prepare("SELECT chat_id FROM admins").all();
  for (const admin of results) {
    const r = await send(env, admin.chat_id, ...screen(job.paymentScreen(payment, found)));
    if (r && r.result && r.result.message_id) {
      await env.DB.prepare("INSERT INTO payment_notices (payment_id, chat_id, message_id) VALUES (?, ?, ?)")
        .bind(payment.id, admin.chat_id, r.result.message_id)
        .run();
    }
  }
}

export async function confirmPayment(env, q, ctx) {
  const [, verdict, id] = q.data.split(":");
  const admin = await env.DB.prepare("SELECT chat_id FROM admins WHERE chat_id = ?").bind(q.from.id).first();
  const payment = admin && (await getPayment(env, Number(id)));
  if (!payment) return answerCallback(env, q, admin ? "Оплата не найдена" : "Только для модераторов");
  await answerCallback(env, q);
  const ok = verdict === "ok";
  const { meta } = await env.DB.prepare(
    `UPDATE payments SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ? AND status = 'pending'`,
  )
    .bind(ok ? "confirmed" : "rejected", job.employerName(q.from), payment.id)
    .run();
  if (meta.changes && ok && payment.kind === "post") {
    // Размещение оплачено: вакансия уходит на проверку (даже если её успели закрыть, за неё заплатили)
    await env.DB.prepare(
      `UPDATE jobs SET status = 'pending', post_paid = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('payment', 'closed')`,
    )
      .bind(payment.amount, payment.job_id)
      .run();
  } else if (meta.changes && ok) {
    // Продление считаем от конца текущего «Срочно», если оно ещё идёт
    await env.DB.prepare(
      `UPDATE jobs SET boost_until = datetime(MAX(COALESCE(boost_until, datetime('now')), datetime('now')), '+' || ? || ' days'),
         updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(payment.days, payment.job_id)
      .run();
  }
  const now = await getPayment(env, payment.id);
  const found = await getJob(env, payment.job_id);
  const { results } = await env.DB.prepare("SELECT chat_id, message_id FROM payment_notices WHERE payment_id = ?").bind(now.id).all();
  const card = job.paymentScreen(now, found);
  for (const n of results) await edit(env, n.chat_id, n.message_id, card.text, card.keyboard);
  if (!meta.changes) return;
  if (payment.kind === "post") {
    await send(env, found.employer_chat, ok ? job.postPaidText(found) : job.paymentRejectedText(found, "post"));
    if (!ok || found.status !== "pending") return;
    const { results: admins } = await env.DB.prepare("SELECT chat_id FROM admins").all();
    for (const a of admins) await sendNotice(env, a.chat_id, found);
    return wakeSite(env, ctx);  // очередь на проверку (moderation.json) для агента
  }
  await send(env, found.employer_chat, ok ? job.boostedText(found, await siteChannels(env)) : job.paymentRejectedText(found));
  if (ok) wakeSite(env, ctx);
}

// Платное размещение: вакансия в статусе «ждёт оплаты», работодатель переводит на Kaspi и жмёт «Я оплатил»

async function ownUnpaid(env, q) {
  const found = await getJob(env, Number(q.data.split(":")[1]));
  return found && found.employer_chat === q.message.chat.id && found.status === "payment" ? found : null;
}

export async function postPay(env, q) {
  const boost = job.boostOffer(env);
  const found = job.postPrice(boost) && (await ownUnpaid(env, q));
  if (!found) return answerCallback(env, q, "Эта вакансия уже не ждёт оплаты: /myjobs");
  await answerCallback(env, q);
  return send(env, q.message.chat.id, ...screen(job.postPayScreen(found, boost)));
}

export async function postPaid(env, q) {
  const boost = job.boostOffer(env);
  const found = job.postPrice(boost) && (await ownUnpaid(env, q));
  if (!found) return answerCallback(env, q, "Эта вакансия уже не ждёт оплаты: /myjobs");
  const waiting = await env.DB.prepare("SELECT id FROM payments WHERE job_id = ? AND kind = 'post' AND status = 'pending'")
    .bind(found.id).first();
  if (waiting) return answerCallback(env, q, "Уже сверяем ваш перевод, напишу, как только придёт");
  await answerCallback(env, q);
  const { meta } = await env.DB.prepare("INSERT INTO payments (job_id, employer_chat, amount, days, kind) VALUES (?, ?, ?, 0, 'post')")
    .bind(found.id, found.employer_chat, job.postPrice(boost))
    .run();
  await edit(env, q.message.chat.id, q.message.message_id, job.postWaitText(found));
  await notifyPayment(env, await getPayment(env, meta.last_row_id), found);
}

export async function postLater(env, q) {
  const found = await ownUnpaid(env, q);
  await answerCallback(env, q);
  if (found) return edit(env, q.message.chat.id, q.message.message_id, job.postLaterText(found));
}

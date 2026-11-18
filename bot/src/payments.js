// Оплаты на Kaspi: «🔥 Срочно» и платное размещение, подтверждение модератором.
import { creditsLeft, getJob, getPayment, useCredit } from "./db.js";
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
  const credits = await creditsLeft(env, q.message.chat.id);
  return send(env, q.message.chat.id, ...screen(job.boostScreen(found, boost, new Date(), await siteChannels(env), credits)));
}

// «🔥 Списать из пакета»: Про для опубликованной вакансии без оплаты, срок продлевается от текущего конца
export async function boostFromCredit(env, q, ctx) {
  const boost = job.boostOffer(env);
  const found = boost && (await ownApproved(env, q));
  if (!found || found.kind === "shift") return answerCallback(env, q, "Поднять из пакета можно только опубликованную вакансию");
  if (!(await useCredit(env, found.employer_chat))) return answerCallback(env, q, "В пакетах не осталось Про: /employer");
  await answerCallback(env, q);
  await env.DB.prepare(
    `UPDATE jobs SET boost_until = datetime(MAX(COALESCE(boost_until, datetime('now')), datetime('now')), '+' || ? || ' days'),
       updated_at = datetime('now') WHERE id = ?`,
  ).bind(boost.days, found.id).run();
  const now = await getJob(env, found.id);
  await edit(env, q.message.chat.id, q.message.message_id,
    `${job.boostedText(now, await siteChannels(env))}\n\nОсталось Про в пакетах: ${await creditsLeft(env, found.employer_chat)}.`);
  wakeSite(env, ctx);
}

// Пакеты Про: экран с пакетами, оплата на Kaspi, «Я оплатил», модератор подтверждает
export async function showPacks(env, q) {
  const boost = job.boostOffer(env);
  await answerCallback(env, q, boost?.packs?.length ? undefined : "Пакеты пока недоступны");
  if (!boost?.packs?.length) return;
  return send(env, q.message.chat.id, ...screen(job.packsScreen(boost, await creditsLeft(env, q.message.chat.id))));
}

const packOf = (boost, data) => boost?.packs?.find((p) => p.count === Number(data.split(":")[1]));

export async function packPay(env, q) {
  const boost = job.boostOffer(env);
  const pack = packOf(boost, q.data);
  if (!pack) return answerCallback(env, q, "Такого пакета уже нет: /employer");
  await answerCallback(env, q);
  return edit(env, q.message.chat.id, q.message.message_id, ...screen(job.packPayScreen(pack, boost)));
}

export async function packPaid(env, q) {
  const boost = job.boostOffer(env);
  const pack = packOf(boost, q.data);
  if (!pack) return answerCallback(env, q, "Такого пакета уже нет: /employer");
  const chatId = q.message.chat.id;
  const waiting = await env.DB.prepare("SELECT id FROM payments WHERE employer_chat = ? AND kind = 'pack' AND status = 'pending'")
    .bind(chatId).first();
  if (waiting) return answerCallback(env, q, "Уже сверяем ваш перевод за пакет, напишу, как только включим");
  await answerCallback(env, q);
  const name = job.employerName(q.from);
  const { meta } = await env.DB.prepare(
    "INSERT INTO payments (job_id, employer_chat, amount, days, kind, pack, employer_name) VALUES (0, ?, ?, ?, 'pack', ?, ?)",
  ).bind(chatId, pack.price, pack.days, pack.count, name).run();
  await edit(env, chatId, q.message.message_id, job.packWaitText(pack));
  await notifyPayment(env, await getPayment(env, meta.last_row_id), { employer_name: name });
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
    // Размещение оплачено: вакансия уходит на проверку (даже если её успели закрыть, за неё заплатили).
    // Тариф Про (payment.days > 0): срок Про считаем с этой минуты, проверка обычно до часа.
    await env.DB.prepare(
      `UPDATE jobs SET status = 'pending', post_paid = ?, updated_at = datetime('now'),
         boost_until = CASE WHEN ? > 0 THEN datetime('now', '+' || ? || ' days') ELSE boost_until END
       WHERE id = ? AND status IN ('payment', 'closed')`,
    )
      .bind(payment.amount, payment.days, payment.days, payment.job_id)
      .run();
  } else if (meta.changes && ok && payment.kind !== "pack") {
    // Продление считаем от конца текущего «Срочно», если оно ещё идёт
    await env.DB.prepare(
      `UPDATE jobs SET boost_until = datetime(MAX(COALESCE(boost_until, datetime('now')), datetime('now')), '+' || ? || ' days'),
         updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(payment.days, payment.job_id)
      .run();
  }
  const now = await getPayment(env, payment.id);
  if (payment.kind === "pack") return packDecided(env, now, meta.changes > 0, ok);
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
  const days = found.pro ? job.offerFor(boost, found).days : 0;
  const { meta } = await env.DB.prepare("INSERT INTO payments (job_id, employer_chat, amount, days, kind) VALUES (?, ?, ?, ?, 'post')")
    .bind(found.id, found.employer_chat, job.postPriceFor(found, boost), days)
    .run();
  await edit(env, q.message.chat.id, q.message.message_id, job.postWaitText(found));
  await notifyPayment(env, await getPayment(env, meta.last_row_id), found);
}

export async function postLater(env, q) {
  const found = await ownUnpaid(env, q);
  await answerCallback(env, q);
  if (found) return edit(env, q.message.chat.id, q.message.message_id, job.postLaterText(found));
}

// Решение по оплате пакета: обновляем карточки модераторов, включаем пакет и пишем работодателю
async function packDecided(env, payment, changed, ok) {
  const { results } = await env.DB.prepare("SELECT chat_id, message_id FROM payment_notices WHERE payment_id = ?").bind(payment.id).all();
  const card = job.paymentScreen(payment, { employer_name: payment.employer_name });
  for (const n of results) await edit(env, n.chat_id, n.message_id, card.text, card.keyboard);
  if (!changed) return;
  if (!ok) {
    return send(env, payment.employer_chat,
      `Мы не нашли перевод за пакет «${payment.pack} Про». Если вы уже переводили, проверьте сумму и комментарий «Пакет ${payment.pack}» ` +
      "и нажмите «Я оплатил» ещё раз: /employer");
  }
  await env.DB.prepare(
    "INSERT INTO credits (employer_chat, total, left, expires_at, payment_id) VALUES (?, ?, ?, datetime('now', '+' || ? || ' days'), ?)",
  ).bind(payment.employer_chat, payment.pack, payment.pack, payment.days, payment.id).run();
  const credit = await env.DB.prepare("SELECT expires_at FROM credits WHERE payment_id = ?").bind(payment.id).first();
  return send(env, payment.employer_chat, job.packReadyText(payment.pack, credit.expires_at));
}

// Итог Про: когда срок кончился, работодатель получает число откликов и кнопку продлить.
// Раз в час из scheduled (index.js); по каждому сроку (boost_until) один раз, старше двух суток не шлём.
export async function proReports(env) {
  const { results } = await env.DB.prepare(
    `SELECT j.*, (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS applications FROM jobs j
     WHERE j.boost_until IS NOT NULL AND j.boost_until <= datetime('now') AND j.boost_until > datetime('now', '-2 days')
       AND (j.pro_reported IS NULL OR j.pro_reported != j.boost_until) AND j.status IN ('approved', 'closed')`,
  ).all();
  const boost = job.boostOffer(env);
  for (const j of results) {
    await env.DB.prepare("UPDATE jobs SET pro_reported = boost_until WHERE id = ?").bind(j.id).run();
    await send(env, j.employer_chat, ...screen(job.proReportScreen(j, j.applications, boost)));
  }
  return results.length;
}

// Бот @vacantekz_bot. Соискатели настраивают подписку на новые вакансии (logic.js),
// работодатели размещают вакансии через анкету, агент-модератор или админы каналов их проверяют,
// а кандидаты откликаются прямо в боте (employer.js). Решения агента приходят на /api/moderate
// из workflow moderate.yml.
// Telegram присылает обновления вебхуком на /telegram. Всё хранится в D1,
// а подборки каждый час рассылает `python -m vacante digest` из GitHub Actions.
// Ещё воркер раз в час будит это обновление, если расписание GitHub его пропустило (cron.js).
// Профили соискателей хранит сервер в Казахстане: что касается профиля, бот передаёт ему (server.js).
import { dispatchUpdate, wakeUpdate } from "./cron.js";
import { crmApi, jobsApi } from "./crm.js";
import * as job from "./employer.js";
import * as bot from "./logic.js";
import { relayToServer, serverKey } from "./server.js";
import * as shift from "./shift.js";

const GREETING =
  "Привет! Это бот vacante.kz. Я собираю вакансии из десятков Telegram-каналов.\n\n" +
  "🃏 Их можно листать свайпами в приложении: вправо сохранить, влево пропустить.\n" +
  "🔔 А ещё я могу присылать новые вакансии по вашему городу и сфере, настройка ниже.";
const HELP =
  "Я присылаю новые вакансии с vacante.kz.\n/settings: изменить подписку\n/stop: остановить\n\n" +
  "⚡ /smeny: присылать смены и подработку\n\n" +
  "Работодателям:\n/vacancy: разместить вакансию\n/smena: найти людей на смену\n/myjobs: мои вакансии и смены";
const STOPPED = "Больше не присылаю. Чтобы снова получать вакансии, нажмите /start.";
const postIntro = (price) =>
  `Разместим вакансию${price ? ` за ${job.money(price)}` : ""}: на vacante.kz, в приложении и в подборках подписчикам бота. ` +
  "Отклики кандидатов придут вам сюда. Ответьте на несколько вопросов, это пара минут.";
const JOB_CLOSED = "Эта вакансия уже закрыта. Новые вакансии могу присылать сюда: /start";
const PROFILE_DOWN = "Профиль сейчас недоступен, попробуйте через несколько минут.";
// Кнопка «Записать кружок» в приложении открывает чат с ботом командой /start video
const VIDEO_START = /^\/start(@\w+)?\s+video$/;
// Отклики и напоминания списком: они хранятся в профиле, поэтому отвечает сервер
const SERVER_COMMAND = /^\/(otkliki|napominaniya)(@\w+)?$/;
const NO_KEYBOARD = { remove_keyboard: true };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/moderate") return moderationApi(request, env, ctx);
    if (url.pathname === "/api/crm") return crmApi(request, env);  // CRM заведений в админке сайта
    if (url.pathname === "/api/jobs") return jobsApi(request, env);  // кто размещал вакансии, там же
    if (request.method === "POST" && url.pathname === "/internal/report") return reportApi(request, env);  // жалобы из приложения
    if (request.method !== "POST" || url.pathname !== "/telegram") {
      return new Response("vacante.kz bot", { status: 200 });
    }
    const secret = await bot.webhookSecret(env.TELEGRAM_BOT_TOKEN);
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
      return new Response("forbidden", { status: 403 });
    }
    try {
      await handle(await request.json(), env, ctx);
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
    }
    return new Response("ok"); // всегда 200, иначе Telegram будет повторять то же обновление
  },

  // Раз в час (crons в wrangler.toml): подстраховка расписания GitHub, см. cron.js
  async scheduled(event, env, ctx) {
    ctx.waitUntil(wakeUpdate(env).then((result) => console.log(`update.yml: ${result}`)));
    // Смены: напоминания, вопрос «кто пришёл» и закрытие прошедших
    ctx.waitUntil(shiftCron(env).catch((err) => console.error(err && err.stack ? err.stack : err)));
  },
};

async function handle(update, env, ctx) {
  const m = update.message;
  if (m && m.chat.type === "private") {
    // Номер из окна «Поделиться номером» в приложении сервер кладёт в профиль, если приложение
    // его только что попросило, иначе это ответ в отклике, и его ведёт бот, как раньше.
    // Кружок, /start video, /otkliki и /napominaniya целиком на сервере: он хранит профили.
    // Обычное видео сервер берёт, только если у человека есть профиль (подскажет записать кружок),
    // иначе оно остаётся боту
    const text = (m.text || "").trim();
    const command = VIDEO_START.test(text) || SERVER_COMMAND.test(text);
    const profile = !!m.video_note || command;
    if (command) await endDialog(env, m.chat.id); // команда прерывает анкету или отклик, как любая другая
    if (m.contact || m.video || profile) {
      if (await relayToServer(env, update)) return;
      if (profile) return send(env, m.chat.id, PROFILE_DOWN);
    }
    return onMessage(m, env);
  }
  const q = update.callback_query;
  if (!q || !q.message) return;
  const data = q.data || "";
  // Кнопки под сообщениями сервера: о кружке («Убрать из профиля») и под напоминаниями
  if (data.startsWith("v:") || data.startsWith("r:")) {
    if (await relayToServer(env, update)) return;
    return answerCallback(env, q, PROFILE_DOWN);
  }
  if (data.startsWith("mod:")) return moderate(env, q, ctx);
  if (data.startsWith("sh:")) return shiftDecision(env, q, ctx);
  if (data.startsWith("att:")) return attendance(env, q);
  if (data.startsWith("close:")) return closeJob(env, q);
  if (data.startsWith("boost:")) return boostJob(env, q);
  if (data.startsWith("paid:")) return paid(env, q);
  if (data.startsWith("pay:")) return confirmPayment(env, q, ctx);
  if (data.startsWith("postpay:")) return postPay(env, q);
  if (data.startsWith("postpaid:")) return postPaid(env, q);
  if (data.startsWith("postlater:")) return postLater(env, q);
  if (data.startsWith("job") || data.startsWith("skip:")) return postButton(env, q, ctx);
  return subscriptionButton(env, q);
}

async function onMessage(m, env) {
  const chatId = m.chat.id;
  const text = (m.text || "").trim();
  const [command, arg = ""] = text.startsWith("/") ? text.split(/\s+/) : [];
  if (!command) {
    // Не команда: ответ на вопрос анкеты или отклик, если бот его ждёт
    const d = await env.DB.prepare("SELECT * FROM dialogs WHERE chat_id = ?").bind(chatId).first();
    if (d && d.mode === "post") return postAnswer(env, m, d);
    if (d && d.mode === "apply") return applyAnswer(env, m, d);
    if (d && d.mode === "take") return takeAnswer(env, m, d);
    return send(env, chatId, HELP);
  }
  await endDialog(env, chatId); // любая команда прерывает анкету или отклик
  const name = command.split("@")[0];
  if (name === "/start" && arg.startsWith("apply_")) return startApply(env, m, Number(arg.slice(6)));
  if (name === "/start" && arg.startsWith("take_")) return startTake(env, m, Number(arg.slice(5)));
  if ((name === "/start" && arg === "post") || name === "/vacancy") return startPost(env, m);
  if ((name === "/start" && arg === "smena") || name === "/smena") return startPost(env, m, "shift");
  if ((name === "/start" && arg === "smeny") || name === "/smeny") return subscribeShifts(env, chatId);
  if (name === "/start" && bot.fromLink(arg)) {
    // Кнопка «Пришлём, когда появится» из приложения: подписка сразу с городом, сферой и зарплатой
    const sub = bot.fromLink(arg);
    await save(env, chatId, sub);
    return send(env, chatId, `✅ Подписка включена: ${bot.summary(sub)}.\n\nНовые вакансии пришлю сюда. Изменить: /settings, отписаться: /stop`);
  }
  if (name === "/myjobs") return send(env, chatId, ...screen(job.myJobsScreen(await myJobs(env, chatId), job.boostOffer(env))));
  if (name === "/admin") return becomeAdmin(env, m);
  if (name === "/start" || name === "/settings") {
    const sub = await load(env, chatId);
    await save(env, chatId, sub);
    if (name === "/start") await send(env, chatId, GREETING, [[bot.appButton(env.SITE_URL, sub.city)]]);
    const { text: question, keyboard } = bot.screen("city", sub);
    return send(env, chatId, question, keyboard);
  }
  if (name === "/stop") {
    await save(env, chatId, { ...(await load(env, chatId)), active: 0 });
    return send(env, chatId, STOPPED);
  }
  return send(env, chatId, HELP);
}

// Подписка соискателя: кнопки экрана настроек
async function subscriptionButton(env, q) {
  const chatId = q.message.chat.id;
  if (q.data === "settings") {
    // Кнопка под подборкой: настройки новым сообщением, саму подборку не трогаем
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
    const { text, keyboard } = bot.screen("city", await load(env, chatId));
    return send(env, chatId, text, keyboard);
  }
  const { sub, show } = bot.press(await load(env, chatId), q.data || "");
  await save(env, chatId, sub);
  await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
  if (show === "stopped") {
    return tg(env, "editMessageText", { chat_id: chatId, message_id: q.message.message_id, text: STOPPED });
  }
  const { text, keyboard } = bot.screen(show, sub);
  // Подписка готова: тут же предлагаем полистать вакансии этого города в приложении
  const rows = show === "done" ? [[bot.appButton(env.SITE_URL, sub.city)], ...keyboard] : keyboard;
  await tg(env, "editMessageText", {
    chat_id: chatId,
    message_id: q.message.message_id,
    text,
    reply_markup: { inline_keyboard: rows },
  });
  if (show === "done") {
    const feed = await fetch(`${env.SITE_URL}/feed.json`, { cf: { cacheTtl: 300 } }).then((r) => r.json());
    await send(env, chatId, bot.examples(sub, feed.vacancies));
  }
}

// Работодатель: анкета вакансии

async function startPost(env, m, kind = "vacancy") {
  const chatId = m.chat.id;
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE employer_chat = ? AND status IN ('pending', 'payment')")
    .bind(chatId)
    .first("n");
  if (pending >= job.MAX_PENDING) {
    return send(env, chatId, `У вас уже ${pending} вакансии ждут оплаты или проверки. Оплатите или закройте их: /myjobs`);
  }
  await env.DB.prepare("DELETE FROM jobs WHERE employer_chat = ? AND status = 'draft'").bind(chatId).run();
  const { meta } = await env.DB.prepare("INSERT INTO jobs (employer_chat, employer_name, step, kind) VALUES (?, ?, 'city', ?)")
    .bind(chatId, job.employerName(m.from), kind)
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

async function postAnswer(env, m, d) {
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

async function postButton(env, q, ctx) {
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

// Карточка вакансии модератору; запоминаем сообщение, чтобы потом обновить его после решения
async function sendNotice(env, chatId, found) {
  const r = await send(env, chatId, ...screen(job.moderationScreen(found)));
  if (r && r.result && r.result.message_id) {
    await env.DB.prepare("INSERT INTO notices (job_id, chat_id, message_id) VALUES (?, ?, ?)")
      .bind(found.id, chatId, r.result.message_id)
      .run();
  }
}

// После решения карточки у всех модераторов показывают, кто и что решил
async function refreshNotices(env, found) {
  const { results } = await env.DB.prepare("SELECT chat_id, message_id FROM notices WHERE job_id = ?").bind(found.id).all();
  const { text, keyboard } = job.moderationScreen(found);
  for (const n of results) await edit(env, n.chat_id, n.message_id, text, keyboard);
}

function wakeSite(env, ctx) {
  if (env.GH_DISPATCH_TOKEN) ctx?.waitUntil(dispatchUpdate(env).catch((err) => console.warn(String(err))));
}

async function myJobs(env, chatId) {
  const { results } = await env.DB.prepare(
    `SELECT j.*, (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS applications,
       (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.status = 'confirmed') AS confirmed
     FROM jobs j WHERE employer_chat = ? AND status != 'draft' ORDER BY id DESC LIMIT 10`,
  )
    .bind(chatId)
    .all();
  return results;
}

async function closeJob(env, q) {
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

async function ownApproved(env, q) {
  const found = await getJob(env, Number(q.data.split(":")[1]));
  return found && found.employer_chat === q.message.chat.id && found.status === "approved" ? found : null;
}

async function boostJob(env, q) {
  const boost = job.boostOffer(env);
  const found = boost && (await ownApproved(env, q));
  if (!found) return answerCallback(env, q, boost ? "Поднять можно только опубликованную вакансию" : "Услуга пока недоступна");
  await answerCallback(env, q);
  return send(env, q.message.chat.id, ...screen(job.boostScreen(found, boost)));
}

async function paid(env, q) {
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

async function confirmPayment(env, q, ctx) {
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
  await send(env, found.employer_chat, ok ? job.boostedText(found) : job.paymentRejectedText(found));
  if (ok) wakeSite(env, ctx);
}

// Платное размещение: вакансия в статусе «ждёт оплаты», работодатель переводит на Kaspi и жмёт «Я оплатил»

async function ownUnpaid(env, q) {
  const found = await getJob(env, Number(q.data.split(":")[1]));
  return found && found.employer_chat === q.message.chat.id && found.status === "payment" ? found : null;
}

async function postPay(env, q) {
  const boost = job.boostOffer(env);
  const found = job.postPrice(boost) && (await ownUnpaid(env, q));
  if (!found) return answerCallback(env, q, "Эта вакансия уже не ждёт оплаты: /myjobs");
  await answerCallback(env, q);
  return send(env, q.message.chat.id, ...screen(job.postPayScreen(found, boost)));
}

async function postPaid(env, q) {
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

async function postLater(env, q) {
  const found = await ownUnpaid(env, q);
  await answerCallback(env, q);
  if (found) return edit(env, q.message.chat.id, q.message.message_id, job.postLaterText(found));
}

function getPayment(env, id) {
  return env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first();
}

// Модерация: админы каналов vacante подтверждают себя командой /admin

async function becomeAdmin(env, m) {
  const chatId = m.chat.id;
  let isAdmin = false;
  for (const channel of (env.CHANNELS || "").split(",").filter(Boolean)) {
    const member = await tg(env, "getChatMember", { chat_id: channel, user_id: m.from.id });
    if (job.ADMIN_STATUSES.includes(member?.result?.status)) {
      isAdmin = true;
      break;
    }
  }
  if (!isAdmin) return send(env, chatId, HELP);
  await env.DB.prepare("INSERT OR IGNORE INTO admins (chat_id) VALUES (?)").bind(chatId).run();
  const { results } = await env.DB.prepare("SELECT * FROM jobs WHERE status = 'pending' ORDER BY id").all();
  await send(env, chatId, `Готово, вы модератор: вакансии от работодателей будут приходить сюда на проверку. Сейчас ждут: ${results.length}.`);
  for (const pending of results) await sendNotice(env, chatId, pending);
}

async function moderate(env, q, ctx) {
  const [, verdict, id] = q.data.split(":");
  const admin = await env.DB.prepare("SELECT chat_id FROM admins WHERE chat_id = ?").bind(q.from.id).first();
  const found = admin && (await getJob(env, Number(id)));
  if (!found) return answerCallback(env, q, admin ? "Вакансия не найдена" : "Только для модераторов");
  await answerCallback(env, q);
  const approve = verdict === "ok";
  const who = job.employerName(q.from);
  const { meta } = await env.DB.prepare(
    approve
      ? `UPDATE jobs SET status = 'approved', approved_at = datetime('now'), decided_by = ?, updated_at = datetime('now')
         WHERE id = ? AND status = 'pending'`
      : "UPDATE jobs SET status = 'rejected', decided_by = ?, updated_at = datetime('now') WHERE id = ? AND status = 'pending'",
  )
    .bind(who, found.id)
    .run();
  // Если другой модератор или агент успел раньше, карточка просто покажет их решение
  const now = await getJob(env, found.id);
  await edit(env, q.message.chat.id, q.message.message_id, ...screen(job.moderationScreen(now)));
  if (!meta.changes) return;
  await refreshNotices(env, now);
  await send(env, now.employer_chat, ...(approve ? screen(job.approvedScreen(now, job.boostOffer(env))) : [job.rejectedText(now)]));
  // Не ждём часового обновления: сразу запускаем сборку, чтобы вакансия появилась на сайте и в канале за несколько минут
  if (approve) wakeSite(env, ctx);
}

// Агент-модератор: решения из moderate.yml. Каждое решение: {id, verdict: approve|reject|edit, fields, reason}.
// Поля приходят уже оформленными (зарплата, график, адрес, текст); edit только правит поля, не меняя статус.
async function moderationApi(request, env, ctx) {
  const key = await job.moderationKey(env.TELEGRAM_BOT_TOKEN);
  if (request.headers.get("Authorization") !== `Bearer ${key}`) return new Response("forbidden", { status: 403 });
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.decisions)) return Response.json({ error: "нужен {decisions: [...]}" }, { status: 400 });
  const results = [];
  for (const d of body.decisions) {
    try {
      results.push({ id: d.id, result: await review(env, d) });
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      results.push({ id: d.id, result: "error: сбой бота" });
    }
  }
  if (results.some((r) => r.result === "approved" || r.result === "edited")) wakeSite(env, ctx);
  return Response.json({ results });
}

async function review(env, d) {
  const found = await getJob(env, Number(d.id));
  if (!found) return "error: нет такой вакансии";
  if (found.status !== "pending" && found.status !== "approved") return `skipped: ${job.STATUS[found.status]}`;
  if (!["approve", "reject", "edit"].includes(d.verdict)) return "error: verdict = approve, reject или edit";
  const { job: next, error } = job.reviewFields(found, d.fields);
  if (error) return `error: ${error}`;
  // Уже опубликованную (модератор нажал кнопку сам) агент только оформляет
  const status = found.status === "approved" || d.verdict === "edit" ? found.status : d.verdict === "approve" ? "approved" : "rejected";
  const decided = status !== found.status;
  const { meta } = await env.DB.prepare(
    `UPDATE jobs SET status = ?, title = ?, company = ?, salary = ?, schedule = ?, address = ?, details = ?,
       salary_min = ?, salary_max = ?, salary_period = ?, reviewed_at = datetime('now'),
       decided_by = CASE WHEN ? THEN 'агент' ELSE decided_by END,
       approved_at = CASE WHEN ? = 'approved' AND approved_at IS NULL THEN datetime('now') ELSE approved_at END,
       updated_at = datetime('now')
     WHERE id = ? AND status = ?`,
  )
    .bind(status, next.title, next.company, next.salary, next.schedule, next.address, next.details,
      next.salary_min ?? null, next.salary_max ?? null, next.salary_period ?? null, decided ? 1 : 0, status, found.id, found.status)
    .run();
  if (!meta.changes) return "skipped: вакансию только что изменили";
  const saved = await getJob(env, found.id);
  await refreshNotices(env, saved);
  if (!decided) return "edited";
  await send(env, saved.employer_chat,
    ...(status === "approved" ? screen(job.approvedScreen(saved, job.boostOffer(env))) : [job.rejectedText(saved, d.reason)]));
  return status;
}

// Кандидат: отклик по ссылке t.me/vacantekz_bot?start=apply_<id> с сайта или из канала

async function startApply(env, m, id) {
  const chatId = m.chat.id;
  const found = id ? await getJob(env, id) : null;
  if (found && found.kind === "shift") return startTake(env, m, id);
  if (!found || found.status !== "approved") return send(env, chatId, JOB_CLOSED);
  const applied = await env.DB.prepare("SELECT id FROM applications WHERE job_id = ? AND chat_id = ?").bind(id, chatId).first();
  if (applied) return send(env, chatId, "Вы уже откликнулись на эту вакансию, работодатель получил отклик и свяжется с вами сам.");
  await setDialog(env, chatId, "apply", id);
  return send(env, chatId, job.applyIntro(found), job.CONTACT_KEYBOARD);
}

async function applyAnswer(env, m, d) {
  const chatId = m.chat.id;
  const phone = m.contact ? m.contact.phone_number : null;
  if (!m.text && !phone) return send(env, chatId, "Напишите о себе текстом или отправьте номер кнопкой внизу.");
  await endDialog(env, chatId);
  const found = await getJob(env, d.job_id);
  if (!found || found.status !== "approved") return send(env, chatId, JOB_CLOSED, NO_KEYBOARD);
  await env.DB.prepare("INSERT INTO applications (job_id, chat_id) VALUES (?, ?)").bind(found.id, chatId).run();
  await send(env, found.employer_chat, job.applicationText(found, m.from, m.text, phone));
  return send(
    env,
    chatId,
    "✅ Отклик отправлен работодателю, он свяжется с вами сам.\n\nХотите получать новые вакансии по своему городу? /start",
    NO_KEYBOARD,
  );
}

// Смены (shift.js): «Беру смену» по ссылке t.me/vacantekz_bot?start=take_<id> с сайта, из приложения или канала

const SHIFT_GONE = "Эта смена уже закрыта или набрана. Другие смены и подработка: /smeny";

function shiftOpen(found, now = new Date()) {
  return found && found.kind === "shift" && found.status === "approved" && shift.shiftTimes(found).start > now;
}

// Надёжность соискателя: сколько смен отметили и на скольких он был
async function reliabilityOf(env, chatId) {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS total, COALESCE(SUM(attended), 0) AS came FROM applications WHERE chat_id = ? AND attended IS NOT NULL",
  )
    .bind(chatId)
    .first();
  return { total: Number(r.total), came: Number(r.came) };
}

async function startTake(env, m, id) {
  const chatId = m.chat.id;
  const found = id ? await getJob(env, id) : null;
  if (!shiftOpen(found)) return send(env, chatId, SHIFT_GONE);
  if (found.employer_chat === chatId) return send(env, chatId, "Это ваша смена. Просьбы кандидатов придут сюда, список: /myjobs");
  const mine = await env.DB.prepare("SELECT status FROM applications WHERE job_id = ? AND chat_id = ? AND status != 'cancelled'")
    .bind(id, chatId)
    .first();
  if (mine && mine.status === "confirmed") return send(env, chatId, "Вас уже ждут на этой смене. Если не сможете прийти, нажмите «Не смогу прийти» в сообщении о подтверждении.");
  if (mine) return send(env, chatId, "Вы уже попросились на эту смену. Работодатель ответит здесь, обычно в течение пары часов.");
  await setDialog(env, chatId, "take", id);
  return send(env, chatId, shift.takeIntro(found), job.CONTACT_KEYBOARD);
}

async function takeAnswer(env, m, d) {
  const chatId = m.chat.id;
  const phone = m.contact ? m.contact.phone_number : null;
  if (!m.text && !phone) return send(env, chatId, "Отправьте номер кнопкой внизу или напишите о себе текстом.");
  await endDialog(env, chatId);
  const found = await getJob(env, d.job_id);
  if (!shiftOpen(found)) return send(env, chatId, SHIFT_GONE, NO_KEYBOARD);
  const { meta } = await env.DB.prepare("INSERT INTO applications (job_id, chat_id, status, name) VALUES (?, ?, 'asked', ?)")
    .bind(found.id, chatId, [m.from.first_name, m.from.last_name].filter(Boolean).join(" ").slice(0, 60))
    .run();
  const rel = await reliabilityOf(env, chatId);
  await send(env, found.employer_chat, ...screen(shift.takeRequest(found, { id: meta.last_row_id }, m.from, m.text, phone, rel)));
  return send(
    env,
    chatId,
    "✅ Попросились на смену. Работодатель подтвердит здесь, обычно в течение пары часов.\n\nПрисылать новые смены и подработку: /smeny",
    NO_KEYBOARD,
  );
}

async function getApplication(env, id) {
  return env.DB.prepare("SELECT * FROM applications WHERE id = ?").bind(id).first();
}

async function confirmedCount(env, jobId) {
  return Number(await env.DB.prepare("SELECT COUNT(*) AS n FROM applications WHERE job_id = ? AND status = 'confirmed'").bind(jobId).first("n"));
}

// Кнопки «✅ Беру / Не подходит» у работодателя и «Не смогу прийти» у соискателя
async function shiftDecision(env, q, ctx) {
  const [, verdict, id] = q.data.split(":");
  const chatId = q.message.chat.id;
  const a = await getApplication(env, Number(id));
  const found = a && (await getJob(env, a.job_id));
  if (!found) return answerCallback(env, q, "Смена не найдена");
  if (verdict === "cancel") {
    if (a.chat_id !== chatId) return answerCallback(env, q);
    const { meta } = await env.DB.prepare("UPDATE applications SET status = 'cancelled' WHERE id = ? AND status = 'confirmed'").bind(a.id).run();
    await answerCallback(env, q, meta.changes ? "Предупредили работодателя" : undefined);
    if (!meta.changes) return;
    await edit(env, chatId, q.message.message_id, "Отменили: работодатель знает, что вы не придёте. Другие смены: /smeny");
    // Набранная смена снова открывается, если до неё ещё есть время
    if (found.status === "closed" && found.closed_full && shift.shiftTimes(found).start > new Date()) {
      await env.DB.prepare("UPDATE jobs SET status = 'approved', closed_full = 0, updated_at = datetime('now') WHERE id = ?").bind(found.id).run();
      wakeSite(env, ctx);
    }
    return send(env, found.employer_chat, shift.cancelledText(found, q.from));
  }
  if (found.employer_chat !== chatId) return answerCallback(env, q);
  const ok = verdict === "ok";
  if (ok && found.need && (await confirmedCount(env, found.id)) >= found.need) {
    return answerCallback(env, q, `Уже набрали ${found.need} ${shift.people(found.need)}`);
  }
  const { meta } = await env.DB.prepare("UPDATE applications SET status = ? WHERE id = ? AND status = 'asked'")
    .bind(ok ? "confirmed" : "declined", a.id)
    .run();
  await answerCallback(env, q);
  const now = await getApplication(env, a.id);
  const text = `${q.message.text || ""}\n\n${shift.decidedLine(now.status)}`.trim();
  await tg(env, "editMessageText", { chat_id: chatId, message_id: q.message.message_id, text, disable_web_page_preview: true });
  if (!meta.changes) return;
  if (!ok) return send(env, a.chat_id, shift.declinedText(found, env.SITE_URL));
  await send(env, a.chat_id, shift.confirmedText(found, job.BOT_USERNAME).text, shift.cancelButton(a));
  // Набрали всех: смена уходит с сайта, остальным просящим вежливо отвечаем
  if (found.need && (await confirmedCount(env, found.id)) >= found.need && found.status === "approved") {
    await env.DB.prepare("UPDATE jobs SET status = 'closed', closed_full = 1, updated_at = datetime('now') WHERE id = ?").bind(found.id).run();
    await send(env, found.employer_chat, shift.fullText(found));
    wakeSite(env, ctx);
  }
}

// Отметка «пришёл / не пришёл» после смены
async function attendance(env, q) {
  const [, value, id] = q.data.split(":");
  if (value === "done") return answerCallback(env, q, "Уже отмечено");
  const a = await getApplication(env, Number(id));
  const found = a && (await getJob(env, a.job_id));
  if (!found || found.employer_chat !== q.message.chat.id) return answerCallback(env, q);
  const { meta } = await env.DB.prepare("UPDATE applications SET attended = ? WHERE id = ? AND status = 'confirmed' AND attended IS NULL")
    .bind(value === "1" ? 1 : 0, a.id)
    .run();
  await answerCallback(env, q);
  const { results } = await env.DB.prepare("SELECT id, name, attended FROM applications WHERE job_id = ? AND status = 'confirmed' ORDER BY id")
    .bind(found.id)
    .all();
  await edit(env, q.message.chat.id, q.message.message_id, ...screen(shift.attendanceScreen(found, results)));
  if (meta.changes && value === "1") await send(env, a.chat_id, shift.attendedText(found, await reliabilityOf(env, a.chat_id)));
}

// /smeny: подписка на смены и подработку в своём городе
async function subscribeShifts(env, chatId) {
  const sub = await load(env, chatId);
  const next = { ...sub, perks: sub.perks.includes(bot.SHIFT) ? sub.perks : [...sub.perks, bot.SHIFT] };
  if (!next.city) {
    await save(env, chatId, { ...next, active: 0 });
    return send(env, chatId, "⚡ Буду присылать смены и подработку. Где ищете?", bot.screen("city", next).keyboard);
  }
  await save(env, chatId, { ...next, active: 1 });
  return send(
    env,
    chatId,
    `⚡ Готово: присылаю смены и подработку (${bot.summary(next)}).\n\nВсе смены сейчас: ${env.SITE_URL}/${next.city}/smeny/\nИзменить: /settings`,
  );
}

// Будильник раз в час: напоминание за несколько часов до смены, после смены вопрос «кто пришёл»,
// закрытие прошедших смен (с сайта они уходят при следующем обновлении)
export async function shiftCron(env, now = new Date()) {
  const { results: jobs } = await env.DB.prepare(
    "SELECT * FROM jobs WHERE kind = 'shift' AND status IN ('approved', 'closed') AND attendance_asked = 0 AND shift_date >= ?",
  )
    .bind(shift.localDay(now, -2))
    .all();
  for (const j of jobs) {
    const { start, end } = shift.shiftTimes(j);
    const { results: apps } = await env.DB.prepare("SELECT * FROM applications WHERE job_id = ? AND status = 'confirmed' ORDER BY id")
      .bind(j.id)
      .all();
    if (start > now && start - now <= shift.REMIND_HOURS * 3600e3) {
      for (const a of apps.filter((x) => !x.reminded)) {
        await env.DB.prepare("UPDATE applications SET reminded = 1 WHERE id = ?").bind(a.id).run();
        await send(env, a.chat_id, shift.remindText(j, now), shift.cancelButton(a));
      }
    }
    if (start <= now && j.status === "approved") {
      await env.DB.prepare("UPDATE jobs SET status = 'closed', updated_at = datetime('now') WHERE id = ?").bind(j.id).run();
      // Кто попросился, но не дождался ответа
      await env.DB.prepare("UPDATE applications SET status = 'declined' WHERE job_id = ? AND status = 'asked'").bind(j.id).run();
    }
    if (end <= now) {
      await env.DB.prepare("UPDATE jobs SET attendance_asked = 1 WHERE id = ?").bind(j.id).run();
      if (apps.length) await send(env, j.employer_chat, ...screen(shift.attendanceScreen(j, apps, now)));
    }
  }
}

// База и Telegram

function getJob(env, id) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first();
}

function setDialog(env, chatId, mode, jobId) {
  return env.DB.prepare(
    `INSERT INTO dialogs (chat_id, mode, job_id) VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET mode = excluded.mode, job_id = excluded.job_id`,
  )
    .bind(chatId, mode, jobId)
    .run();
}

function endDialog(env, chatId) {
  return env.DB.prepare("DELETE FROM dialogs WHERE chat_id = ?").bind(chatId).run();
}

async function load(env, chatId) {
  const row = await env.DB.prepare("SELECT * FROM subscribers WHERE chat_id = ?").bind(chatId).first();
  return bot.fromRow(row);
}

async function save(env, chatId, sub) {
  await env.DB.prepare(
    `INSERT INTO subscribers (chat_id, city, categories, perks, min_pay, active) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET city = excluded.city, categories = excluded.categories, perks = excluded.perks,
       min_pay = excluded.min_pay, active = excluded.active, updated_at = datetime('now')`,
  )
    .bind(chatId, ...bot.toRow(sub))
    .run();
}

const screen = ({ text, keyboard }) => [text, keyboard];

// keyboard: список рядов инлайн-кнопок или готовая reply_markup (например, кнопка «Отправить номер»)
function markup(keyboard) {
  if (Array.isArray(keyboard)) return keyboard.length ? { inline_keyboard: keyboard } : undefined;
  return keyboard;
}

const REPORT_REASONS = {
  fraud: "мошенничество",
  prepay: "просят предоплату",
  contacts: "не отвечают по контактам",
  closed: "вакансия уже закрыта",
  wrong: "неверные данные",
  other: "другое",
};

// Жалоба соискателя на вакансию: сервер проверил вход через Telegram и передаёт её сюда, а бот
// пишет всем модераторам. Имя жалобщика не передаём, только его номер в Telegram для связи
async function reportApi(request, env) {
  if (request.headers.get("authorization") !== `Bearer ${await serverKey(env.TELEGRAM_BOT_TOKEN)}`) {
    return new Response("forbidden", { status: 403 });
  }
  const r = await request.json().catch(() => ({}));
  const esc = (v) => String(v ?? "").slice(0, 500).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = [
    `🚩 Жалоба на вакансию: ${esc(REPORT_REASONS[r.reason] ?? REPORT_REASONS.other)}`,
    `<b>${esc(r.title) || esc(r.vacancy_id)}</b>${r.employer ? ` · ${esc(r.employer)}` : ""}`,
  ];
  if (r.text) lines.push(`«${esc(r.text)}»`);
  if (r.url) lines.push(esc(r.url));
  lines.push(`id: ${esc(r.vacancy_id)} · от tg://user?id=${Number(r.from) || 0}`);
  const { results } = await env.DB.prepare("SELECT chat_id FROM admins").all();
  for (const admin of results) await send(env, admin.chat_id, lines.join("\n"));
  return Response.json({ ok: true, sent: results.length });
}

function send(env, chatId, text, keyboard) {
  const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (markup(keyboard)) body.reply_markup = markup(keyboard);
  return tg(env, "sendMessage", body);
}

function edit(env, chatId, messageId, text, keyboard) {
  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (markup(keyboard)) body.reply_markup = markup(keyboard);
  return tg(env, "editMessageText", body);
}

function answerCallback(env, q, text) {
  return tg(env, "answerCallbackQuery", text ? { callback_query_id: q.id, text } : { callback_query_id: q.id });
}

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) console.warn(`Telegram ${method}: ${r.status} ${data.description || ""}`);
  return data;
}

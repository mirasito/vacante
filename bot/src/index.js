// Бот @vacantekz_bot. Соискатели настраивают подписку на новые вакансии (logic.js),
// работодатели размещают вакансии через анкету, админы каналов их проверяют,
// а кандидаты откликаются прямо в боте (employer.js).
// Telegram присылает обновления вебхуком на /telegram. Всё хранится в D1,
// а подборки каждый час рассылает `python -m vacante digest` из GitHub Actions.
// Ещё воркер раз в час будит это обновление, если расписание GitHub его пропустило (cron.js).
import { dispatchUpdate, wakeUpdate } from "./cron.js";
import * as job from "./employer.js";
import * as bot from "./logic.js";

const GREETING =
  "Привет! Это бот vacante.kz. Я собираю вакансии из десятков Telegram-каналов и присылаю новые по вашему городу и сфере.";
const HELP =
  "Я присылаю новые вакансии с vacante.kz.\n/settings: изменить подписку\n/stop: остановить\n\n" +
  "Работодателям:\n/vacancy: разместить вакансию бесплатно\n/myjobs: мои вакансии";
const STOPPED = "Больше не присылаю. Чтобы снова получать вакансии, нажмите /start.";
const POST_INTRO =
  "Разместим вакансию бесплатно: на vacante.kz и в подборках подписчикам бота. " +
  "Отклики кандидатов придут вам сюда. Ответьте на несколько вопросов, это пара минут.";
const JOB_CLOSED = "Эта вакансия уже закрыта. Новые вакансии могу присылать сюда: /start";
const NO_KEYBOARD = { remove_keyboard: true };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
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
  },
};

async function handle(update, env, ctx) {
  if (update.message && update.message.chat.type === "private") return onMessage(update.message, env);
  const q = update.callback_query;
  if (!q || !q.message) return;
  const data = q.data || "";
  if (data.startsWith("mod:")) return moderate(env, q, ctx);
  if (data.startsWith("close:")) return closeJob(env, q);
  if (data.startsWith("job") || data.startsWith("skip:")) return postButton(env, q);
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
    return send(env, chatId, HELP);
  }
  await endDialog(env, chatId); // любая команда прерывает анкету или отклик
  const name = command.split("@")[0];
  if (name === "/start" && arg.startsWith("apply_")) return startApply(env, m, Number(arg.slice(6)));
  if ((name === "/start" && arg === "post") || name === "/vacancy") return startPost(env, m);
  if (name === "/myjobs") return send(env, chatId, ...screen(job.myJobsScreen(await myJobs(env, chatId))));
  if (name === "/admin") return becomeAdmin(env, m);
  if (name === "/start" || name === "/settings") {
    const sub = await load(env, chatId);
    await save(env, chatId, sub);
    const { text: question, keyboard } = bot.screen("city", sub);
    const intro = name === "/start" ? `${GREETING}\n\n` : "";
    return send(env, chatId, intro + question, keyboard);
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
  await tg(env, "editMessageText", {
    chat_id: chatId,
    message_id: q.message.message_id,
    text,
    reply_markup: { inline_keyboard: keyboard },
  });
  if (show === "done") {
    const feed = await fetch(`${env.SITE_URL}/feed.json`, { cf: { cacheTtl: 300 } }).then((r) => r.json());
    await send(env, chatId, bot.examples(sub, feed.vacancies));
  }
}

// Работодатель: анкета вакансии

async function startPost(env, m) {
  const chatId = m.chat.id;
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE employer_chat = ? AND status = 'pending'")
    .bind(chatId)
    .first("n");
  if (pending >= job.MAX_PENDING) {
    return send(env, chatId, `У вас уже ${pending} вакансии на проверке. Дождитесь ответа, обычно это пара часов: /myjobs`);
  }
  await env.DB.prepare("DELETE FROM jobs WHERE employer_chat = ? AND status = 'draft'").bind(chatId).run();
  const { meta } = await env.DB.prepare("INSERT INTO jobs (employer_chat, employer_name, step) VALUES (?, ?, 'city')")
    .bind(chatId, job.employerName(m.from))
    .run();
  await setDialog(env, chatId, "post", meta.last_row_id);
  const { text, keyboard } = job.askScreen(job.STEPS[0]);
  return send(env, chatId, `${POST_INTRO}\n\n${text}`, keyboard);
}

async function postAnswer(env, m, d) {
  const chatId = m.chat.id;
  const draft = await getJob(env, d.job_id);
  if (!draft || draft.status !== "draft") {
    await endDialog(env, chatId);
    return send(env, chatId, HELP);
  }
  if (!draft.step) return send(env, chatId, ...screen(job.previewScreen(draft))); // анкета заполнена, ждём кнопку
  const { job: next, error } = job.answer(draft, draft.step, m.text);
  if (error) return send(env, chatId, error, job.askScreen(job.STEPS.find((s) => s.field === draft.step)).keyboard);
  return advance(env, chatId, next);
}

async function postButton(env, q) {
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
  if (q.data === "jobsend") return draft.step ? null : submit(env, chatId, messageId, draft);
  const next = job.pressed(draft, q.data);
  return next && advance(env, chatId, next, messageId);
}

// Следующий вопрос анкеты или, когда всё заполнено, предпросмотр. По кнопке правим то же сообщение.
async function advance(env, chatId, draft, messageId) {
  const step = job.nextStep(draft);
  draft = { ...draft, step: step ? step.field : null };
  await env.DB.prepare(
    `UPDATE jobs SET step = ?, city = ?, title = ?, company = ?, salary = ?, schedule = ?, address = ?, details = ?,
       updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(draft.step, draft.city, draft.title, draft.company, draft.salary, draft.schedule, draft.address, draft.details, draft.id)
    .run();
  const { text, keyboard } = step ? job.askScreen(step) : job.previewScreen(draft);
  return messageId ? edit(env, chatId, messageId, text, keyboard) : send(env, chatId, text, keyboard);
}

async function submit(env, chatId, messageId, draft) {
  await env.DB.prepare("UPDATE jobs SET status = 'pending', updated_at = datetime('now') WHERE id = ?").bind(draft.id).run();
  await endDialog(env, chatId);
  await edit(env, chatId, messageId, `${job.card(draft)}\n\n⏳ Отправили на проверку, напишу, когда опубликуем. Ваши вакансии: /myjobs`);
  const { results } = await env.DB.prepare("SELECT chat_id FROM admins").all();
  const { text, keyboard } = job.moderationScreen(draft);
  for (const admin of results) await send(env, admin.chat_id, text, keyboard);
}

async function myJobs(env, chatId) {
  const { results } = await env.DB.prepare(
    `SELECT j.*, (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS applications
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
     WHERE id = ? AND employer_chat = ? AND status IN ('pending', 'approved')`,
  )
    .bind(id, chatId)
    .run();
  await answerCallback(env, q, meta.changes ? "Вакансия закрыта, с сайта она уйдёт в течение часа" : undefined);
  const { text, keyboard } = job.myJobsScreen(await myJobs(env, chatId));
  return edit(env, chatId, q.message.message_id, text, keyboard);
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
  for (const pending of results) await send(env, chatId, ...screen(job.moderationScreen(pending)));
}

async function moderate(env, q, ctx) {
  const chatId = q.message.chat.id;
  const [, verdict, id] = q.data.split(":");
  const admin = await env.DB.prepare("SELECT chat_id FROM admins WHERE chat_id = ?").bind(q.from.id).first();
  const found = admin && (await getJob(env, Number(id)));
  if (!found) return answerCallback(env, q, admin ? "Вакансия не найдена" : "Только для модераторов");
  await answerCallback(env, q);
  const approve = verdict === "ok";
  const { meta } = await env.DB.prepare(
    approve
      ? "UPDATE jobs SET status = 'approved', approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
      : "UPDATE jobs SET status = 'rejected', updated_at = datetime('now') WHERE id = ? AND status = 'pending'",
  )
    .bind(found.id)
    .run();
  const { text } = job.moderationScreen(found);
  if (!meta.changes) {
    // Другой модератор успел раньше или работодатель закрыл вакансию
    const now = await getJob(env, found.id);
    return edit(env, chatId, q.message.message_id, `${text}\n\nУже ${job.STATUS[now.status]}.`);
  }
  const who = job.employerName(q.from);
  await edit(env, chatId, q.message.message_id, `${text}\n\n${approve ? "✅ Опубликовал" : "❌ Отклонил"}: ${job.esc(who)}`);
  await send(env, found.employer_chat, approve ? job.approvedText(found) : job.rejectedText(found));
  if (approve && env.GH_DISPATCH_TOKEN) {
    // Не ждём часового обновления: сразу запускаем сборку, чтобы вакансия появилась на сайте за несколько минут
    ctx?.waitUntil(dispatchUpdate(env).catch((err) => console.warn(String(err))));
  }
}

// Кандидат: отклик по ссылке t.me/vacantekz_bot?start=apply_<id> с сайта или из канала

async function startApply(env, m, id) {
  const chatId = m.chat.id;
  const found = id ? await getJob(env, id) : null;
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

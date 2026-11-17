// Бот @vacantekz_bot. Соискатели настраивают подписку на новые вакансии (logic.js),
// работодатели размещают вакансии через анкету, агент-модератор или админы каналов их проверяют,
// а кандидаты откликаются прямо в боте (employer.js). Решения агента приходят на /api/moderate
// из workflow moderate.yml.
// Telegram присылает обновления вебхуком на /telegram. Всё хранится в D1,
// а подборки каждый час рассылает `python -m vacante digest` из GitHub Actions.
// Ещё воркер раз в час будит это обновление, если расписание GitHub его пропустило (cron.js).
// Профили соискателей хранит сервер в Казахстане: что касается профиля, бот передаёт ему (server.js).
import { applyAnswer, startApply } from "./applying.js";
import { crmApi, jobsApi } from "./crm.js";
import { wakeDaily, wakeUpdate } from "./cron.js";
import { endDialog, load, myJobs, save } from "./db.js";
import * as job from "./employer.js";
import * as bot from "./logic.js";
import { becomeAdmin, moderate, moderationApi, reportApi } from "./moderation.js";
import { boostJob, confirmPayment, paid, postLater, postPaid, postPay } from "./payments.js";
import { closeJob, postAnswer, postButton, startPost } from "./posting.js";
import { relayToServer } from "./server.js";
import { attendance, shiftCron, shiftDecision, startTake, subscribeShifts, takeAnswer } from "./taking.js";
import { answerCallback, screen, send, tg } from "./telegram.js";
import { HELP } from "./texts.js";

// Будильник смен вызывают тесты и scheduled ниже
export { shiftCron };

const GREETING =
  "Привет! Это бот vacante.kz. Я собираю вакансии из десятков Telegram-каналов.\n\n" +
  "🃏 Их можно листать свайпами в приложении: вправо сохранить, влево пропустить.\n" +
  "🔔 А ещё я могу присылать новые вакансии по вашему городу и сфере, настройка ниже.";

const STOPPED = "Больше не присылаю. Чтобы снова получать вакансии, нажмите /start.";

const PROFILE_DOWN = "Профиль сейчас недоступен, попробуйте через несколько минут.";

// Кнопка «Записать кружок» в приложении открывает чат с ботом командой /start video
const VIDEO_START = /^\/start(@\w+)?\s+video$/;

// Отклики и напоминания списком: они хранятся в профиле, поэтому отвечает сервер
// Профиль работодателя /company тоже на сервере: там CRM работодателей и их заведения (server/src/crm-bot.ts)
const SERVER_COMMAND = /^\/(otkliki|napominaniya|company)(@\w+)?$/;

// Ответы на вопросы сервера о компании: «🏠 Новое заведение» и «🔎 Поиск компании»
const SERVER_REPLY = /^(🏠 Новое заведение|🔎 Поиск компании)/;

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
    // Утренние ролики и черновик поста: расписания GitHub у них нет, запускает только этот будильник
    ctx.waitUntil(wakeDaily(env).then((result) => console.log(`утро: ${JSON.stringify(result)}`)));
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
    const answer = !!text && SERVER_REPLY.test(m.reply_to_message?.text || "");
    const profile = !!m.video_note || command || answer;
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
  if (data.startsWith("v:") || data.startsWith("r:") || data.startsWith("c:")) {
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
  // Кнопка на странице профиля кандидата (server/src/page.ts): работодатель увидел отклик и пришёл размещать
  if (name === "/start" && arg === "post_pf") return startPost(env, m, "vacancy", "profile");
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

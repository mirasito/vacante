// Бот для соискателей @vacantekz_bot: настройка подписки на новые вакансии.
// Telegram присылает обновления вебхуком на /telegram. Подписки хранятся в D1,
// а сами подборки каждый час рассылает `python -m vacante digest` из GitHub Actions.
import * as bot from "./logic.js";

const GREETING =
  "Привет! Это бот vacante.kz. Я собираю вакансии из десятков Telegram-каналов и присылаю новые по вашему городу и сфере.";
const HELP = "Я присылаю новые вакансии с vacante.kz.\n/settings: изменить подписку\n/stop: остановить";
const STOPPED = "Больше не присылаю. Чтобы снова получать вакансии, нажмите /start.";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/telegram") {
      return new Response("vacante.kz bot", { status: 200 });
    }
    const secret = await bot.webhookSecret(env.TELEGRAM_BOT_TOKEN);
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
      return new Response("forbidden", { status: 403 });
    }
    try {
      await handle(await request.json(), env);
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
    }
    return new Response("ok"); // всегда 200, иначе Telegram будет повторять то же обновление
  },
};

async function handle(update, env) {
  if (update.message && update.message.chat.type === "private") {
    const chatId = update.message.chat.id;
    const text = (update.message.text || "").trim();
    if (text.startsWith("/start") || text.startsWith("/settings")) {
      const sub = await load(env, chatId);
      await save(env, chatId, sub);
      const { text: question, keyboard } = bot.screen("city", sub);
      const intro = text.startsWith("/start") ? `${GREETING}\n\n` : "";
      return send(env, chatId, intro + question, keyboard);
    }
    if (text.startsWith("/stop")) {
      await save(env, chatId, { ...(await load(env, chatId)), active: 0 });
      return send(env, chatId, STOPPED);
    }
    return send(env, chatId, HELP);
  }

  const q = update.callback_query;
  if (!q || !q.message) return;
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

function send(env, chatId, text, keyboard) {
  const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  return tg(env, "sendMessage", body);
}

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) console.warn(`Telegram ${method}: ${r.status} ${(await r.json().catch(() => ({}))).description || ""}`);
}

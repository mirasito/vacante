// Bot API: отправка, правка сообщений и ответы на кнопки. Ошибки Telegram только пишутся в лог.
export const screen = ({ text, keyboard }) => [text, keyboard];

// keyboard: список рядов инлайн-кнопок или готовая reply_markup (например, кнопка «Отправить номер»)
function markup(keyboard) {
  if (Array.isArray(keyboard)) return keyboard.length ? { inline_keyboard: keyboard } : undefined;
  return keyboard;
}

export function send(env, chatId, text, keyboard) {
  const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (markup(keyboard)) body.reply_markup = markup(keyboard);
  return tg(env, "sendMessage", body);
}

export function edit(env, chatId, messageId, text, keyboard) {
  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (markup(keyboard)) body.reply_markup = markup(keyboard);
  return tg(env, "editMessageText", body);
}

export function answerCallback(env, q, text) {
  return tg(env, "answerCallbackQuery", text ? { callback_query_id: q.id, text } : { callback_query_id: q.id });
}

export async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) console.warn(`Telegram ${method}: ${r.status} ${data.description || ""}`);
  return data;
}

// Вход на сайт через Telegram без паролей и без настройки домена в BotFather.
//   POST /api/login        — новый код и ссылка t.me/<бот>?start=login_<код>
//   GET  /api/login?code=  — { pending } пока человек не подтвердил в боте, потом { session, user } (один раз)
// В боте /start login_<код> спрашивает «Войти на vacante.kz?», кнопка login:<код> подтверждает.
// Ключ входа — id и имя из Telegram с подписью токеном бота, живёт SESSION_DAYS; кабинет принимает его
// в заголовке Authorization: session <ключ> так же, как initData из Mini App.
import { BOT_USERNAME } from "./employer.js";
import { answerCallback, send, tg } from "./telegram.js";

export const CODE_MINUTES = 10;
export const SESSION_DAYS = 30;
const CODE = /^[0-9a-f]{24}$/;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (text) => new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)));

async function sign(token, text) {
  const raw = new TextEncoder().encode(`vacante-site-session:${token}`);
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

/** Подписанный ключ входа для пользователя Telegram. */
export async function makeSession(token, user, nowMs = Date.now()) {
  const body = b64(JSON.stringify({ id: user.id, first_name: user.first_name || "", exp: Math.floor(nowMs / 1000) + SESSION_DAYS * 86400 }));
  return `${body}.${await sign(token, body)}`;
}

/** Пользователь из ключа входа или null. */
export async function verifySession(raw, token, nowMs = Date.now()) {
  const [body, mac, extra] = String(raw || "").split(".");
  if (!body || !mac || extra !== undefined || !/^[0-9a-f]{64}$/.test(mac)) return null;
  if ((await sign(token, body)) !== mac) return null;
  try {
    const user = JSON.parse(unb64(body));
    if (!Number.isSafeInteger(user.id) || user.id <= 0 || !(user.exp > nowMs / 1000)) return null;
    return { id: user.id, first_name: user.first_name || "" };
  } catch {
    return null;
  }
}

const fresh = `datetime('now', '-${CODE_MINUTES} minutes')`;

export async function loginApi(request, env, headers) {
  if (request.method === "POST") {
    await env.DB.prepare(`DELETE FROM logins WHERE created_at < ${fresh}`).run();
    const code = hex(crypto.getRandomValues(new Uint8Array(12)));
    await env.DB.prepare("INSERT INTO logins (code) VALUES (?)").bind(code).run();
    return Response.json({ code, link: `https://t.me/${BOT_USERNAME}?start=login_${code}`, minutes: CODE_MINUTES }, { headers });
  }
  if (request.method !== "GET") return Response.json({ error: "method" }, { status: 405, headers });
  const code = new URL(request.url).searchParams.get("code") || "";
  const row = CODE.test(code) &&
    (await env.DB.prepare(`SELECT * FROM logins WHERE code = ? AND created_at >= ${fresh}`).bind(code).first());
  if (!row) return Response.json({ error: "Ссылка для входа устарела, нажмите «Войти» ещё раз" }, { status: 410, headers });
  if (!row.chat_id) return Response.json({ pending: true }, { headers });
  await env.DB.prepare("DELETE FROM logins WHERE code = ?").bind(code).run();
  const user = { id: row.chat_id, first_name: row.first_name || "" };
  return Response.json({ session: await makeSession(env.TELEGRAM_BOT_TOKEN, user), user }, { headers });
}

/** /start login_<код>: спросить, точно ли человек входит на сайт. */
export async function startLogin(env, m, code) {
  const row = CODE.test(code) &&
    (await env.DB.prepare(`SELECT chat_id FROM logins WHERE code = ? AND created_at >= ${fresh}`).bind(code).first());
  if (!row || row.chat_id) return send(env, m.chat.id, "Ссылка для входа устарела. Нажмите «Войти через Telegram» на сайте ещё раз.");
  return send(env, m.chat.id,
    "Войти на сайт vacante.kz под этим Telegram?\nОсы Telegram арқылы vacante.kz сайтына кіру керек пе?\n\n" +
      "Подтверждайте, только если вы сами сейчас нажали «Войти» на сайте.\nСайтта «Кіру» батырмасын өзіңіз басқан болсаңыз ғана растаңыз.",
    [[{ text: "✅ Да, войти · Иә, кіру", callback_data: `login:${code}` }]]);
}

/** Кнопка «Да, войти». */
export async function confirmLogin(env, q) {
  const code = q.data.slice(6);
  const from = q.from || {};
  const done = CODE.test(code) && (await env.DB.prepare(
    `UPDATE logins SET chat_id = ?, first_name = ? WHERE code = ? AND chat_id IS NULL AND created_at >= ${fresh}`,
  ).bind(q.message.chat.id, from.first_name || "", code).run()).meta.changes > 0;
  await answerCallback(env, q, done ? "Готово" : "Ссылка устарела");
  return tg(env, "editMessageText", {
    chat_id: q.message.chat.id,
    message_id: q.message.message_id,
    text: done ? "✅ Вход подтверждён. Вернитесь на вкладку vacante.kz, всё откроется само.\n✅ Кіру расталды. vacante.kz бетіне оралыңыз."
      : "Ссылка для входа устарела. Нажмите «Войти через Telegram» на сайте ещё раз.",
  });
}

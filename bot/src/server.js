// Сервер Vacante в Казахстане (server/ в репозитории) хранит профили соискателей, а бот о людях
// ничего не хранит. Обновления, которые могут касаться профиля, бот передаёт серверу на
// /internal/telegram, и сервер сам отвечает человеку. Сейчас это номер из окна Telegram
// «Поделиться номером», которое открывает приложение.

/** Ключ для /internal/telegram: считается из токена бота так же, как на сервере (internalKey). */
export async function serverKey(token) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode("vacante-server-internal"));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Передаёт обновление серверу. true, если сервер его обработал и ответил сам; false, если
 * обновление не для профиля или сервер недоступен: тогда бот отвечает как раньше.
 */
export async function relayToServer(env, update) {
  if (!env.SERVER_URL) return false;
  try {
    const res = await fetch(`${env.SERVER_URL}/internal/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await serverKey(env.TELEGRAM_BOT_TOKEN)}` },
      body: JSON.stringify(update),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      console.warn(`server /internal/telegram: ${res.status}`);
      return false;
    }
    const data = await res.json().catch(() => ({}));
    return data.handled === true;
  } catch (err) {
    console.warn(`server /internal/telegram: ${err}`);
    return false;
  }
}

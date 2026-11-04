// Всё, что связано с Telegram: проверка входа из Mini App и вызовы Bot API.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface TgUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface InitData {
  user: TgUser;
  /** Когда Telegram выдал данные, секунды Unix. */
  authDate: number;
  startParam?: string;
}

/** Данные входа живут сутки: Telegram выдаёт новые при каждом открытии Mini App. */
export const INIT_DATA_MAX_AGE = 24 * 60 * 60;

/**
 * Проверяет Telegram.WebApp.initData по правилам Telegram: строка из всех полей, кроме hash,
 * по алфавиту через перевод строки, подписанная HMAC-SHA-256 ключом из токена бота.
 * Возвращает пользователя или null, если подпись не сошлась или данные устарели.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifyInitData(raw: string, botToken: string, nowMs = Date.now()): InitData | null {
  const params = new URLSearchParams(raw);
  const hash = params.get("hash") ?? "";
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const given = Buffer.from(hash, "hex");
  // Поле signature (Bot API 8.0) входит в подписанную строку; без него тоже пробуем,
  // это не ослабляет проверку: подделать подпись без токена бота нельзя ни так, ни так
  const signed = [["hash"], ["hash", "signature"]].some((skip) => {
    const check = [...params.entries()]
      .filter(([key]) => !skip.includes(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    return timingSafeEqual(createHmac("sha256", secret).update(check).digest(), given);
  });
  if (!signed) return null;

  const authDate = Number(params.get("auth_date"));
  const age = nowMs / 1000 - authDate;
  if (!Number.isInteger(authDate) || age > INIT_DATA_MAX_AGE || age < -300) return null;

  let user: TgUser;
  try {
    user = JSON.parse(params.get("user") ?? "") as TgUser;
  } catch {
    return null;
  }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.first_name !== "string") return null;
  const startParam = params.get("start_param") ?? undefined;
  return { user, authDate, ...(startParam ? { startParam } : {}) };
}

/**
 * Общий ключ сервера и бота на Cloudflare для внутренних адресов /internal/…
 * Считается из токена бота, поэтому отдельный секрет не нужен (так же бот считает свой).
 */
export const internalKey = (botToken: string) =>
  createHmac("sha256", botToken).update("vacante-server-internal").digest("hex");

export class TelegramError extends Error {
  code: number;
  constructor(method: string, code: number, description: string) {
    super(`${method}: ${code} ${description}`);
    this.code = code;
  }
}

type Fetch = typeof fetch;

/** Вызовы Bot API: сервер сам пишет людям в чат бота и скачивает их кружки. */
export class Bot {
  readonly token: string;
  readonly fetch: Fetch;
  constructor(token: string, fetchImpl: Fetch = fetch) {
    this.token = token;
    this.fetch = fetchImpl;
  }

  async call<T = unknown>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; error_code?: number; description?: string };
    if (!data.ok) throw new TelegramError(method, data.error_code ?? res.status, data.description ?? "");
    return data.result as T;
  }

  /** Скачивает файл, который человек прислал боту (getFile, затем /file/bot…). Не больше maxBytes. */
  async download(fileId: string, maxBytes: number): Promise<Buffer> {
    const file = await this.call<TgFile>("getFile", { file_id: fileId });
    if (!file.file_path) throw new TelegramError("getFile", 400, "нет file_path");
    if ((file.file_size ?? 0) > maxBytes) throw new TelegramError("getFile", 413, `файл ${file.file_size} байт`);
    const res = await this.fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok || !res.body) throw new TelegramError("file", res.status, res.statusText);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > maxBytes) throw new TelegramError("file", 413, `больше ${maxBytes} байт`);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}

export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

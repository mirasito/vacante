// Маленький роутер поверх node:http: без фреймворков, чтобы на сервере не было
// сторонних зависимостей. Ответ обработчика описывается объектом Reply.
import { createReadStream } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Какой сайт спросили: API для приложения и бота или страницы профиля для работодателей. */
export type Site = "api" | "profile";

export interface Request {
  method: string;
  path: string;
  query: URLSearchParams;
  site: Site;
  headers: IncomingHttpHeaders;
  params: Record<string, string>;
  header(name: string): string | undefined;
  /** Тело запроса как JSON (не больше limit байт). */
  json<T = unknown>(): Promise<T>;
  /** Тело HTML-формы (application/x-www-form-urlencoded). */
  form(): Promise<URLSearchParams>;
  /** Тело как есть, не больше limit байт (фото). */
  bytes(limit: number): Promise<Buffer>;
}

export interface Reply {
  status?: number;
  /** Несколько значений одного заголовка (Set-Cookie) передаются списком. */
  headers?: Record<string, string | string[]>;
  json?: unknown;
  html?: string;
  /** Отдать готовые байты. */
  body?: Buffer | Uint8Array;
  /** Отдать кусок файла с диска потоком, байты с start по end включительно (кружок). */
  file?: { path: string; start: number; end: number };
}

export type Handler = (req: Request) => Promise<Reply> | Reply;

export interface Route {
  method: string;
  site: Site | "any";
  pattern: RegExp;
  handler: Handler;
}

export const BODY_LIMIT = 64 * 1024;

export function route(method: string, site: Site | "any", path: string, handler: Handler): Route {
  // /me/applications/:id → ^/me/applications/(?<id>[^/]+)$
  const source = path.replace(/:(\w+)/g, "(?<$1>[^/]+)");
  return { method, site, pattern: new RegExp(`^${source}$`), handler };
}

/** Сколько лишнего ещё дочитываем в никуда после 413, чтобы ответ дошёл до приложения. */
const DRAIN_LIMIT = 16 * 1024 * 1024;

export function readBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      chunks.length = 0;
      reject(err);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // Слишком большое тело: отвечаем 413, а остаток дочитываем, не сохраняя. Если сразу
      // оборвать соединение, приложение увидит обрыв связи вместо понятной ошибки
      if (size > limit) fail(new HttpError(413, "Слишком большой запрос"));
      if (size > limit + DRAIN_LIMIT) req.destroy();
      if (!done) chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", fail);
    req.on("close", () => fail(new HttpError(400, "Запрос оборвался")));
  });
}

export function makeRequest(raw: IncomingMessage, site: Site, params: Record<string, string>, url: URL): Request {
  let body: Promise<Buffer> | undefined;
  const read = (limit = BODY_LIMIT) => (body ??= readBody(raw, limit));
  const text = async () => (await read()).toString("utf8");
  return {
    method: raw.method ?? "GET",
    path: url.pathname,
    query: url.searchParams,
    site,
    headers: raw.headers,
    params,
    header: (name) => {
      const value = raw.headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    },
    async json<T>() {
      const source = await text();
      try {
        return JSON.parse(source || "null") as T;
      } catch {
        throw new HttpError(400, "Тело запроса не JSON");
      }
    },
    async form() {
      return new URLSearchParams(await text());
    },
    bytes: (limit) => read(limit),
  };
}

export function send(res: ServerResponse, reply: Reply) {
  const headers: Record<string, string | string[]> = { "X-Content-Type-Options": "nosniff", ...reply.headers };
  if (reply.file) {
    const { path, start, end } = reply.file;
    headers["Content-Length"] = String(end - start + 1);
    res.writeHead(reply.status ?? 200, headers);
    if (res.req?.method === "HEAD" || end < start) return res.end();
    const stream = createReadStream(path, { start, end });
    stream.on("error", () => res.destroy());
    stream.pipe(res);
    return;
  }
  let payload: Buffer | Uint8Array | string = "";
  if (reply.json !== undefined) {
    headers["Content-Type"] ??= "application/json; charset=utf-8";
    payload = JSON.stringify(reply.json);
  } else if (reply.html !== undefined) {
    headers["Content-Type"] ??= "text/html; charset=utf-8";
    payload = reply.html;
  } else if (reply.body !== undefined) {
    payload = reply.body;
  }
  res.writeHead(reply.status ?? 200, headers);
  res.end(payload);
}

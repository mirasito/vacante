// Общие заготовки тестов: сервер на случайном порту с базой в памяти и подписанный вход Telegram.
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApp, type Deps } from "../src/app.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { openDb, type Db } from "../src/db.ts";
import { Bot } from "../src/telegram.ts";

export const TOKEN = "123456:TEST-token_for-vacante-tests-0000";
export const NOW = Date.parse("2026-11-04T06:00:00Z");

/** initData так, как его подписывает Telegram. */
export function signInitData(fields: Record<string, string>, token = TOKEN): string {
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const check = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

export function initDataFor(user: Record<string, unknown>, authDate = NOW / 1000 - 60, extra: Record<string, string> = {}) {
  return signInitData({ auth_date: String(Math.floor(authDate)), query_id: "AAE1", user: JSON.stringify(user), ...extra });
}

export const AIGERIM = { id: 7001, first_name: "Айгерим", language_code: "ru" };

export interface Sent {
  method: string;
  body: Record<string, unknown>;
}

/**
 * Bot API, который ничего не отправляет, а запоминает вызовы. Файлы, которые «прислали боту»,
 * лежат в files по file_id: getFile и скачивание отдают их, как настоящий Telegram.
 */
export function fakeBot(sent: Sent[] = [], files: Map<string, Buffer> = new Map()): Bot {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const download = /\/file\/bot[^/]+\/f\/(.+)$/.exec(href);
    if (download) {
      const bytes = files.get(decodeURIComponent(download[1]!));
      return bytes ? new Response(new Uint8Array(bytes)) : new Response("Not Found", { status: 404 });
    }
    const method = href.split("/").pop() ?? "";
    const body = JSON.parse(String(init?.body ?? "{}"));
    sent.push({ method, body });
    if (method === "getFile") {
      const bytes = files.get(body.file_id);
      if (!bytes) return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: invalid file_id" }));
      const result = { file_id: body.file_id, file_unique_id: `u${body.file_id}`, file_size: bytes.length, file_path: `f/${body.file_id}` };
      return new Response(JSON.stringify({ ok: true, result }));
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
  }) as typeof fetch;
  return new Bot(TOKEN, fetchImpl);
}

export interface TestServer {
  db: Db;
  config: Config;
  sent: Sent[];
  /** Файлы, которые бот «получил»: file_id → байты. */
  files: Map<string, Buffer>;
  /** Дождаться фоновой работы сервера (скачивание кружков). */
  idle(): Promise<void>;
  call(method: string, path: string, opts?: { host?: string; headers?: Record<string, string>; body?: unknown }): Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    text: string;
    json: any;
    body: Buffer;
  }>;
  close(): Promise<void>;
}

export async function startServer(overrides: Partial<Deps> = {}, env: Record<string, string> = {}): Promise<TestServer> {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: TOKEN,
    VACANTE_VERSION: "test",
    DATA_DIR: mkdtempSync(join(tmpdir(), "vacante-test-")),
    ...env,
  });
  const db = openDb(":memory:");
  const sent: Sent[] = [];
  const files = new Map<string, Buffer>();
  const tasks: Promise<unknown>[] = [];
  const server: Server = createServer(
    createApp({
      config,
      db,
      bot: fakeBot(sent, files),
      now: () => NOW,
      background: (task) => void tasks.push(task),
      ...overrides,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    db,
    config,
    sent,
    files,
    async idle() {
      while (tasks.length) await Promise.all(tasks.splice(0));
    },
    call(method, path, opts = {}) {
      const body = opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      return new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method,
            path,
            headers: {
              host: opts.host ?? "api.vacante.kz",
              ...(body !== undefined && !opts.headers?.["content-type"] ? { "content-type": "application/json" } : {}),
              ...opts.headers,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
              const raw = Buffer.concat(chunks);
              const text = raw.toString("utf8");
              let json: unknown;
              try {
                json = JSON.parse(text);
              } catch {
                json = undefined;
              }
              resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json, body: raw });
            });
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
        db.close();
        rmSync(config.dataDir, { recursive: true, force: true });
      }),
  };
}

/** Одно число из базы: SELECT COUNT(*) AS n … */
export const count = (s: { db: Db }, sql: string, ...args: (string | number)[]) =>
  Number((s.db.prepare(sql).get(...args) as { n: number }).n);

export const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

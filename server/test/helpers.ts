// Общие заготовки тестов: сервер на случайном порту с базой в памяти и подписанный вход Telegram.
import { createHmac } from "node:crypto";
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

/** Bot API, который ничего не отправляет, а запоминает вызовы. */
export function fakeBot(sent: Sent[] = []): Bot {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split("/").pop() ?? "";
    sent.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
  }) as typeof fetch;
  return new Bot(TOKEN, fetchImpl);
}

export interface TestServer {
  db: Db;
  config: Config;
  sent: Sent[];
  call(method: string, path: string, opts?: { host?: string; headers?: Record<string, string>; body?: unknown }): Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    text: string;
    json: any;
  }>;
  close(): Promise<void>;
}

export async function startServer(overrides: Partial<Deps> = {}): Promise<TestServer> {
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: TOKEN, VACANTE_VERSION: "test" });
  const db = openDb(":memory:");
  const sent: Sent[] = [];
  const server: Server = createServer(createApp({ config, db, bot: fakeBot(sent), now: () => NOW, ...overrides }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    db,
    config,
    sent,
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
              const text = Buffer.concat(chunks).toString("utf8");
              let json: unknown;
              try {
                json = JSON.parse(text);
              } catch {
                json = undefined;
              }
              resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
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
      }),
  };
}

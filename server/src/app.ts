// Обработчик всех запросов сервера. Caddy принимает HTTPS для api.vacante.kz и p.vacante.kz
// и передаёт запросы сюда, а здесь по имени хоста решаем, какой это сайт.
import type { IncomingMessage, ServerResponse } from "node:http";

import { hostOf, type Config } from "./config.ts";
import type { Db } from "./db.ts";
import { HttpError, makeRequest, route, send, type Reply, type Request, type Route, type Site } from "./http.ts";
import { internalRoutes } from "./internal.ts";
import { meRoutes } from "./me.ts";
import { pageRoutes } from "./page.ts";
import { verifyInitData, type Bot, type InitData } from "./telegram.ts";

export interface Deps {
  config: Config;
  db: Db;
  bot: Bot;
  now?: () => number;
  /** Работа после ответа на запрос (скачать кружок из Telegram). Тесты её дожидаются. */
  background?: (task: Promise<unknown>) => void;
  /** Запросы наружу, кроме Bot API: исходный пост на t.me в момент отклика. */
  fetch?: typeof fetch;
}

export interface Ctx extends Deps {
  now: () => number;
  background: (task: Promise<unknown>) => void;
  fetch: typeof fetch;
  /** Кто открыл Mini App: проверяет подпись Telegram в заголовке Authorization: tma <initData>. */
  auth(req: Request): InitData;
}

export function createApp(deps: Deps) {
  const ctx: Ctx = {
    ...deps,
    now: deps.now ?? Date.now,
    background: deps.background ?? ((task) => void task.catch((err) => console.error(err))),
    fetch: deps.fetch ?? fetch,
    auth(req) {
      const header = req.header("authorization") ?? "";
      const raw = header.startsWith("tma ") ? header.slice(4) : "";
      const data = raw ? verifyInitData(raw, deps.config.botToken, ctx.now()) : null;
      if (!data) throw new HttpError(401, "Нужен вход через Telegram");
      return data;
    },
  };
  const routes = buildRoutes(ctx);
  const apiHost = hostOf(deps.config.apiOrigin);
  const profileHost = hostOf(deps.config.profileOrigin);
  const origins = new Set(deps.config.appOrigins);

  return async (raw: IncomingMessage, res: ServerResponse) => {
    const host = (raw.headers.host ?? "").toLowerCase();
    const site: Site | undefined =
      host === apiHost || /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? "api" : host === profileHost ? "profile" : undefined;
    const url = new URL(raw.url ?? "/", "http://local");
    const origin = raw.headers.origin;
    const cors: Record<string, string> =
      site === "api" && origin && origins.has(origin)
        ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
        : {};
    try {
      if (!site) throw new HttpError(404, "Неизвестный адрес");
      if (raw.method === "OPTIONS") {
        return send(res, {
          status: 204,
          headers: {
            ...cors,
            "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE",
            "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Vacante-Beta",
            "Access-Control-Max-Age": "86400",
          },
        });
      }
      const { handler, params } = match(routes, raw.method ?? "GET", site, url.pathname);
      const reply = await handler(makeRequest(raw, site, params, url));
      send(res, withHeaders(reply, site, cors));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err instanceof Error ? err.stack : err);
      const message = err instanceof HttpError ? err.message : "Ошибка сервера";
      send(res, { status, json: { error: message }, headers: { ...cors, "Cache-Control": "no-store" } });
    }
  };
}

function match(routes: Route[], method: string, site: Site, path: string) {
  let allowed = false;
  for (const r of routes) {
    if (r.site !== "any" && r.site !== site) continue;
    const m = r.pattern.exec(path);
    if (!m) continue;
    if (r.method !== method && !(r.method === "GET" && method === "HEAD")) {
      allowed = true;
      continue;
    }
    return { handler: r.handler, params: { ...m.groups } };
  }
  throw allowed ? new HttpError(405, "Метод не поддерживается") : new HttpError(404, "Не найдено");
}

function withHeaders(reply: Reply, site: Site, cors: Record<string, string>): Reply {
  const extra: Record<string, string | string[]> = { ...cors };
  if (!reply.headers?.["Cache-Control"]) extra["Cache-Control"] = "no-store";
  if (site === "profile") {
    // Страницы профиля не для поисковиков и не передают адрес дальше по ссылкам
    extra["X-Robots-Tag"] = "noindex, nofollow, noarchive";
    extra["Referrer-Policy"] = "no-referrer";
  }
  return { ...reply, headers: { ...extra, ...reply.headers } };
}

function buildRoutes(ctx: Ctx): Route[] {
  return [
    route("GET", "any", "/health", () => {
      ctx.db.prepare("SELECT 1").get();
      return { json: { ok: true, version: ctx.config.version } };
    }),
    ...meRoutes(ctx),
    ...internalRoutes(ctx),
    ...pageRoutes(ctx),
  ];
}

// Сбор вакансий OLX.kz с сервера в Казахстане (решение Мираса от 2026-11-05: с серверов GitHub OLX отвечает 403).
// Часовой сбор на GitHub (vacante/sources/olx.py) спрашивает здесь две страницы OLX, а сервер берёт их у OLX
// сам и отдаёт как есть. Это не открытый прокси: только с ключом internalKey, только два пути, которые
// разрешает robots.txt OLX.kz, только известные параметры, не чаще запроса в PAUSE_MS.
// Робот представляется честно (USER_AGENT со ссылкой на vacante.kz), без подделки браузера и куки:
// если OLX ответит 403 или капчей и отсюда, сбор просто пропустит запуск.
import { timingSafeEqual } from "node:crypto";

import type { Ctx } from "./app.ts";
import { HttpError, route, type Request, type Route } from "./http.ts";
import { internalKey } from "./telegram.ts";

export const OLX = "https://www.olx.kz";
export const USER_AGENT = "vacante.kz/1.0 (+https://vacante.kz; job aggregator, links back to olx.kz)";
export const PAUSE_MS = 3000;
const PATHS: Record<string, readonly string[]> = {
  "/api/v1/categories/": [],
  "/api/v1/offers/": ["category_id", "offset", "limit", "sort_by"],
};

export function olxRoutes(ctx: Ctx): Route[] {
  const key = Buffer.from(internalKey(ctx.config.botToken));
  let last = 0;
  const handler = async (req: Request) => {
    const given = Buffer.from((req.header("authorization") ?? "").replace(/^Bearer /, ""));
    if (given.length !== key.length || !timingSafeEqual(given, key)) throw new HttpError(403, "Нет доступа");
    const path = req.path.slice("/internal/olx".length);
    const allowed = PATHS[path];
    if (!allowed) throw new HttpError(404, "Нет такой страницы");
    const query = new URLSearchParams();
    for (const [k, v] of req.query) {
      if (!allowed.includes(k) || !/^[\w:.-]{1,40}$/.test(v)) throw new HttpError(400, `Параметр ${k} не нужен`);
      query.set(k, v);
    }
    const now = ctx.now();
    if (now - last < PAUSE_MS) throw new HttpError(429, "Не чаще запроса в 3 секунды");
    last = now;
    const url = `${OLX}${path}${query.size ? `?${query}` : ""}`;
    let res: Response;
    try {
      res = await ctx.fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(25_000),
      });
    } catch (err) {
      throw new HttpError(504, `OLX не ответил: ${(err as Error).name}`);
    }
    const body = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get("content-type") ?? "application/octet-stream";
    // Статус OLX отдаём отдельным заголовком: 403 самого сервера (нет ключа) не путается с 403 OLX
    return { status: 200, headers: { "Content-Type": type, "X-Olx-Status": String(res.status) }, body };
  };
  return Object.keys(PATHS).map((p) => route("GET", "api", `/internal/olx${p}`, handler));
}

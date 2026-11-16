// Часовой сбор вакансий OLX.kz самим сервером: то же, что делает облачный агент командой
// `python -m vacante.sources.olx_cloud run` (vacante/sources/olx_web.py), но без внешнего агента.
// Раз в час сервер читает до MAX_PAGES страниц открытой рубрики https://www.olx.kz/rabota/, берёт объявления
// из window.__PRERENDERED_STATE__ и кладёт их в olx_ads той же дорогой, что и /olx/worker/import (storeItems).
// Часовой сбор на GitHub забирает их, как и раньше, через GET /internal/olx/imports и сам решает,
// какие из них рабочие вакансии известных городов (to_vacancy в vacante/sources/olx.py).
//
// ЖЁСТКОЕ ПРАВИЛО (решение Мираса от 2026-11-05, см. server/src/olx.ts): робот представляется честно.
// Любой ответ, кроме 200, капча или страница, которую не удалось разобрать, — сбор сразу останавливается
// до следующего часа. Никаких повторов, смены User-Agent, подделки браузера, куки и прокси.
// Скрытые телефоны («Показать телефон») сервер не запрашивает: номер берётся только из текста объявления.
import { timingSafeEqual } from "node:crypto";

import type { Ctx } from "./app.ts";
import type { Db } from "./db.ts";
import { HttpError, route, type Route } from "./http.ts";
import { storeItems } from "./olx-import.ts";
import { OLX, PAUSE_MS, USER_AGENT } from "./olx.ts";
import { internalKey } from "./telegram.ts";

export const MAX_PAGES = 5;
const EVERY_MS = 60 * 60_000;
const FRESH_MS = 14 * 86_400_000;
const STATE = /window\.__PRERENDERED_STATE__\s*=\s*/;
const JOB = /^https:\/\/www\.olx\.kz\/(?:d\/)?obyavlenie\/rabota\/[^/?#]+\.html$/;

type Deps = Pick<Ctx, "config" | "db" | "now" | "fetch">;
type Sleep = (ms: number) => Promise<unknown>;
const wait: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface OlxRun {
  at: string;
  /** ok, HTTP 403, timeout, bad page, network error. */
  status: string;
  pages: number;
  stored: number;
  inserted: number;
}

/** Страница, которую не удалось разобрать: нет разметки списка, не тот номер страницы, капча. */
class BadPage extends Error {}

/** Где кончается значение JSON, начатое в text[start]: строка или объект. Как raw_decode в Python. */
function jsonEnd(text: string, start: number): number {
  const first = text[start];
  if (first !== '"' && first !== "{" && first !== "[") throw new BadPage("Разметка списка не JSON");
  let depth = 0;
  let quoted = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    if (!quoted && depth === 0) return i + 1;
  }
  throw new BadPage("Разметка списка оборвана");
}

/** Список объявлений со страницы рубрики. number — номер страницы с единицы; OLX считает с нуля. */
export function parseListing(page: string, number: number): { ads: unknown[]; totalPages: number } {
  const marker = STATE.exec(page);
  if (!marker) throw new BadPage("OLX не вернул разметку списка");
  const start = marker.index + marker[0].length;
  let result: Record<string, unknown> | undefined;
  try {
    let data: unknown = JSON.parse(page.slice(start, jsonEnd(page, start)));
    if (typeof data === "string") data = JSON.parse(data);
    result = (data as { listing?: { listing?: Record<string, unknown> } } | null)?.listing?.listing;
  } catch {
    throw new BadPage("Разметка списка не разбирается");
  }
  const total = typeof result?.totalPages === "string" ? Number(result.totalPages) : result?.totalPages;
  if (!result || result.pageNumber !== number - 1 || !Array.isArray(result.ads) || !Number.isInteger(total)) {
    throw new BadPage("Неожиданный номер или формат страницы OLX");
  }
  return { ads: result.ads, totalPages: total as number };
}

/** Объявление рубрики «Работа» в виде, который принимает storeItems. null — не вакансия, закрыто или старше 14 дней. */
export function parseAd(input: unknown, now: number): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const ad = input as Record<string, unknown>;
  if (!ad.isJob || ad.isActive === false) return null;
  const url = typeof ad.url === "string" ? ad.url : "";
  if (!JOB.test(url) || !Number.isInteger(ad.id) || typeof ad.description !== "string") return null;
  const created = typeof ad.createdTime === "string" ? Date.parse(ad.createdTime) : NaN;
  if (!Number.isFinite(created) || created < now - FRESH_MS || created > now) return null;
  const pay = (ad.salary && typeof ad.salary === "object" ? ad.salary : {}) as Record<string, unknown>;
  const location = (ad.location && typeof ad.location === "object" ? ad.location : {}) as Record<string, unknown>;
  return {
    id: ad.id,
    url,
    title: ad.title,
    description: ad.description,
    created_time: new Date(created).toISOString(),
    last_refresh_time: ad.lastRefreshTime,
    map: ad.map,
    salary: { from: pay.from, to: pay.to, type: pay.period, currency: pay.currencyCode, arranged: pay.negotiable },
    city: location.cityName,
  };
}

/** Последняя попытка сбора или null, если их ещё не было. */
export function lastOlxRun(db: Db): OlxRun | null {
  const row = db.prepare("SELECT at, status, pages, stored, inserted FROM olx_hourly WHERE id = 1").get() as OlxRun | undefined;
  return row ? { at: row.at, status: row.status, pages: row.pages, stored: row.stored, inserted: row.inserted } : null;
}

/**
 * Один проход: до MAX_PAGES страниц с паузой PAUSE_MS между ними. На первом же плохом ответе останавливается
 * (правило в шапке файла): что уже прочитано с прежних страниц, остаётся в базе, статус пишется как есть.
 */
export async function collectOlx(deps: Pick<Deps, "db" | "now" | "fetch">, sleep: Sleep = wait): Promise<OlxRun> {
  const run: OlxRun = { at: new Date(deps.now()).toISOString(), status: "ok", pages: 0, stored: 0, inserted: 0 };
  const seen = new Set<unknown>();
  try {
    for (let number = 1; number <= MAX_PAGES; number++) {
      if (number > 1) await sleep(PAUSE_MS);
      const res = await deps.fetch(`${OLX}/rabota/${number > 1 ? `?page=${number}` : ""}`, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
        redirect: "manual",
        signal: AbortSignal.timeout(25_000),
      });
      if (res.status !== 200) {
        run.status = `HTTP ${res.status}`;
        break;
      }
      const page = parseListing(await res.text(), number);
      run.pages++;
      const now = deps.now();
      const rows = page.ads.map((ad) => parseAd(ad, now)).filter((row) => row !== null && !seen.has(row.id));
      for (const row of rows) seen.add(row!.id);
      if (rows.length) {
        const saved = storeItems(deps.db, rows, now, true);
        run.stored += saved.stored;
        run.inserted += saved.inserted ?? 0;
      }
      if (number >= page.totalPages || !page.ads.length) break;
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    run.status = err instanceof BadPage ? "bad page" : name === "TimeoutError" || name === "AbortError" ? "timeout" : name === "TypeError" ? "network error" : "error";
  }
  deps.db
    .prepare(
      `INSERT INTO olx_hourly (id, at, status, pages, stored, inserted) VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET at = excluded.at, status = excluded.status, pages = excluded.pages,
         stored = excluded.stored, inserted = excluded.inserted`,
    )
    .run(run.at, run.status, run.pages, run.stored, run.inserted);
  return run;
}

/**
 * Планировщик в процессе сервера. Раз в checkMs смотрит, прошёл ли час с прошлой попытки (она записана в базе),
 * поэтому перезапуск сервера при выкладке не добавляет OLX лишних запросов. OLX_HOURLY=0 сбор выключает.
 */
export function startOlxHourly(deps: Deps, firstMs = 90_000, checkMs = 5 * 60_000): () => void {
  if (!deps.config.olxHourly) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const last = lastOlxRun(deps.db);
      if (last && deps.now() - Date.parse(last.at) < EVERY_MS) return;
      const run = await collectOlx(deps);
      console.log(`olx: страниц ${run.pages}, записано ${run.stored}, новых ${run.inserted}, статус ${run.status}`);
    } catch (err) {
      console.error(`olx: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, firstMs);
  const timer = setInterval(tick, checkMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

/** Последняя попытка сбора для владельца: GET /internal/olx/hourly с тем же ключом, что у /internal/olx/*. */
export function olxHourlyRoutes(ctx: Ctx): Route[] {
  const key = Buffer.from(internalKey(ctx.config.botToken));
  return [
    route("GET", "api", "/internal/olx/hourly", (req) => {
      const given = Buffer.from((req.header("authorization") ?? "").replace(/^Bearer /, ""));
      if (given.length !== key.length || !timingSafeEqual(given, key)) throw new HttpError(403, "Нет доступа");
      return { json: { enabled: ctx.config.olxHourly, pages_max: MAX_PAGES, every_minutes: EVERY_MS / 60_000, last: lastOlxRun(ctx.db) } };
    }),
  ];
}

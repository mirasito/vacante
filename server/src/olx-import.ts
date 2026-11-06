// Объявления OLX, которые Мирас забирает в своём браузере. Решение 2026-11-05: OLX не пускает нашего робота
// ни с серверов GitHub, ни с этого сервера (403), а обходить защиту под видом браузера мы не будем.
// Поэтому страницы OLX смотрит сам Мирас, как обычный пользователь, а закладка «Забрать в vacante»
// (страница GET /olx/) читает на открытой странице рубрики «Работа» уже загруженные объявления
// (window.__PRERENDERED_STATE__ или карточки списка), ничего у OLX не запрашивая, и передаёт их
// на эту же страницу через postMessage. Страница шлёт их на POST /olx/import с ключом из пароля админки
// (sha256("olx:" + ADMIN_PASSWORD), его считает выкладка в server.yml и кладёт в OLX_IMPORT_KEY).
// Сервер хранит объявления 30 дней; телефон из описания хранится отдельно от очищенного текста, а часовой сбор на GitHub забирает
// новые через GET /internal/olx/imports (vacante/sources/olx.py) и показывает на сайте со ссылкой на OLX.
import { createHash, timingSafeEqual } from "node:crypto";

import { normalizePhone } from "./profile.ts";
import type { Db } from "./db.ts";
import type { Ctx } from "./app.ts";
import { html, raw } from "./html.ts";
import { HttpError, route, type Request, type Route } from "./http.ts";
import { internalKey } from "./telegram.ts";

export const OLX_ORIGINS = ["https://www.olx.kz", "https://olx.kz", "https://m.olx.kz"];
const OLX_URL = "https://www.olx.kz/";
const MAX_ITEMS = 300;
const BODY_LIMIT = 4 * 1024 * 1024;
const KEEP_DAYS = 30;
const PHONE = /(?<!\d)(?:\+?[78][\s(-]*)?\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

export interface OlxSalary {
  from?: number;
  to?: number;
  currency?: string;
  type?: string;
  arranged?: boolean;
}

interface Row {
  id: number;
  url: string;
  title: string;
  description: string;
  phone: string | null;
  salary: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
  detailed: number;
  created_time: string | null;
  refreshed_time: string | null;
  imported_at: string;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Дата из объявления, если она похожа на правду: не из будущего и не старше 60 дней. */
function when(v: unknown, now: number): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t > now + 86_400_000 || t < now - 60 * 86_400_000) return null;
  return new Date(t).toISOString();
}

/** Чистит объявление из браузера: телефон из текста отдельно, почту и имя автора не сохраняет. null — не объявление OLX. */
export function cleanAd(input: unknown, now: number): Omit<Row, "imported_at"> | null {
  if (!input || typeof input !== "object") return null;
  const a = input as Record<string, unknown>;
  const id = Number(a.id);
  const url = typeof a.url === "string" ? a.url.trim() : "";
  const title = str(a.title, 200);
  if (!Number.isInteger(id) || id <= 0 || id > Number.MAX_SAFE_INTEGER) return null;
  if (!url.startsWith(OLX_URL) || url.length > 300 || /\s/.test(url)) return null;
  if (!title || a.offer_type === "seek") return null;
  const body = (typeof a.description === "string" ? a.description : "")
    .replace(/<\s*(?:br|\/p|\/li|\/div)\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ");
  const phone = [...body.matchAll(PHONE)].map((m) => normalizePhone(m[0])).find(Boolean) ?? null;
  const description = body
    .replace(PHONE, "")
    .replace(EMAIL, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 6000);
  let salary: OlxSalary | null = null;
  if (a.salary && typeof a.salary === "object") {
    const s = a.salary as Record<string, unknown>;
    salary = {};
    if (isNum(s.from) && s.from >= 0 && s.from < 1e9) salary.from = Math.round(s.from);
    if (isNum(s.to) && s.to >= 0 && s.to < 1e9) salary.to = Math.round(s.to);
    if (typeof s.currency === "string") salary.currency = s.currency.slice(0, 5);
    if (typeof s.type === "string") salary.type = s.type.slice(0, 10);
    if (typeof s.arranged === "boolean") salary.arranged = s.arranged;
    if (salary.from === undefined && salary.to === undefined) salary = null;
  }
  let lat: number | null = null;
  let lon: number | null = null;
  let detailed = 0;
  if (a.map && typeof a.map === "object") {
    const m = a.map as Record<string, unknown>;
    if (isNum(m.lat) && isNum(m.lon) && Math.abs(m.lat) <= 90 && Math.abs(m.lon) <= 180) {
      lat = m.lat;
      lon = m.lon;
      detailed = m.show_detailed === true ? 1 : 0;
    }
  }
  return {
    id,
    url,
    title,
    description,
    phone,
    salary: salary ? JSON.stringify(salary) : null,
    city: str(a.city, 60) || null,
    lat,
    lon,
    detailed,
    created_time: when(a.created_time, now),
    refreshed_time: when(a.last_refresh_time, now),
  };
}

/** Объявление в том виде, в каком их отдаёт /api/v1/offers/ OLX: сбор разбирает оба источника одним кодом. */
function asOffer(r: Row) {
  const salary = r.salary ? (JSON.parse(r.salary) as OlxSalary) : null;
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    description: r.description,
    has_phone: Boolean(r.phone),
    created_time: r.created_time ?? r.imported_at,
    last_refresh_time: r.refreshed_time,
    offer_type: "offer",
    params: salary ? [{ key: "salary", name: "Зарплата", type: "salary", value: salary }] : [],
    location: r.city ? { city: { name: r.city } } : {},
    map: r.lat !== null && r.lon !== null ? { lat: r.lat, lon: r.lon, show_detailed: r.detailed === 1 } : null,
    imported_at: r.imported_at,
  };
}

/** Only an imported ad with the matching URL and a fresh contact can disclose a number. */
export const OLX_JOB_URL = /^https:\/\/www\.olx\.kz\/(?:d\/obyavlenie\/|obyavlenie\/rabota\/)[^?#\s]+\.html$/;

export function importedPhone(db: Db, vacancyId: string, url: string, now: number): string | null {
  const id = /^olx-(\d+)$/.exec(vacancyId)?.[1];
  if (!id || !OLX_JOB_URL.test(url)) return null;
  const row = db.prepare("SELECT phone FROM olx_ads WHERE id = ? AND url = ? AND imported_at >= ?")
    .get(Number(id), url, new Date(now - 14 * 86_400_000).toISOString()) as { phone: string | null } | undefined;
  return row?.phone ?? null;
}

export function olxImportRoutes(ctx: Ctx): Route[] {
  const internal = Buffer.from(internalKey(ctx.config.botToken));
  const same = (given: string, key: Buffer) => {
    const g = Buffer.from(given);
    return g.length === key.length && timingSafeEqual(g, key);
  };
  const bearer = (req: Request) => (req.header("authorization") ?? "").replace(/^Bearer /, "");
  const page = `${ctx.config.apiOrigin}/olx/`;

  // Only writers of this repository can publish a verifier. The bearer token
  // never leaves the worker except over TLS to Vacante and can only import ads.
  let grant: { sha256: string; expires: number } | null = null;
  let nextRefresh = 0;
  async function checkWorker(req: Request) {
    const token = bearer(req);
    if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(403, "Нет доступа");
    const now = ctx.now();
    if (now >= nextRefresh) {
      nextRefresh = now + 5000;
      const url = "https://api.github.com/repos/mirasito/vacante/contents/olx-grant.json?ref=olx-cloud-inbox";
      const res = await ctx.fetch(url, { headers: { Accept: "application/vnd.github.raw+json", "User-Agent": "vacante.kz" },
        redirect: "error", signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new HttpError(503, "Ключ сборщика недоступен");
      const data = await res.json() as { sha256?: string; expires_at?: string };
      const expires = Date.parse(data.expires_at ?? "");
      grant = data.sha256 && /^[a-f0-9]{64}$/.test(data.sha256) && expires > now && expires <= now + 21 * 60_000
        ? { sha256: data.sha256, expires } : null;
    }
    const digest = createHash("sha256").update(token).digest("hex");
    if (!grant || grant.expires <= now || !same(digest, Buffer.from(grant.sha256))) throw new HttpError(403, "Нет доступа");
  }

  async function storeAds(req: Request, automatic: boolean) {
    let body: { items?: unknown };
    try {
      body = JSON.parse((await req.bytes(BODY_LIMIT)).toString("utf8") || "{}");
    } catch {
      throw new HttpError(400, "Тело запроса не JSON");
    }
    const items = Array.isArray(body?.items) ? body.items : null;
    if (!items) throw new HttpError(400, "Нет списка объявлений");
    if (items.length > MAX_ITEMS) throw new HttpError(400, `Не больше ${MAX_ITEMS} объявлений за раз`);
    const now = ctx.now();
    const at = new Date(now).toISOString();
    const upsert = ctx.db.prepare(
      `INSERT INTO olx_ads (id, url, title, description, salary, city, lat, lon, detailed, created_time, refreshed_time, imported_at, phone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET url = excluded.url, title = excluded.title, description = excluded.description,
         salary = excluded.salary, city = excluded.city, lat = excluded.lat, lon = excluded.lon, detailed = excluded.detailed,
         created_time = COALESCE(olx_ads.created_time, excluded.created_time), refreshed_time = excluded.refreshed_time,
         imported_at = excluded.imported_at, phone = excluded.phone`,
    );
    let stored = 0;
    let inserted = 0;
    const existing = ctx.db.prepare("SELECT 1 FROM olx_ads WHERE id = ?");
    const phoneIds: number[] = [];
    const seen = new Set<number>();
    for (const item of items) {
      const ad = cleanAd(item, now);
      if (!ad || seen.has(ad.id)) continue;
      seen.add(ad.id);
      if (automatic && !existing.get(ad.id)) inserted++;
      upsert.run(ad.id, ad.url, ad.title, ad.description, ad.salary, ad.city, ad.lat, ad.lon, ad.detailed, ad.created_time, ad.refreshed_time, at, ad.phone);
      if (ad.phone) phoneIds.push(ad.id);
      stored++;
    }
    const old = new Date(now - KEEP_DAYS * 86_400_000).toISOString();
    ctx.db.prepare("DELETE FROM olx_ads WHERE imported_at < ?").run(old);
    const total = (ctx.db.prepare("SELECT count(*) AS n FROM olx_ads").get() as { n: number }).n;
    return { json: { received: items.length, stored, skipped: items.length - stored, total, ...(automatic ? { phone_ids: phoneIds, inserted } : {}) } };
  }

  return [
    route("GET", "api", "/olx/", () => ({
      headers: { "X-Robots-Tag": "noindex, nofollow", "Content-Security-Policy": "frame-ancestors 'none'" },
      html: importPage(page).value,
    })),

    route("POST", "api", "/olx/import", async (req) => {
      if (!ctx.config.olxImportKey) throw new HttpError(503, "Импорт через браузер не настроен");
      if (!same(bearer(req), Buffer.from(ctx.config.olxImportKey))) throw new HttpError(403, "Неверный пароль админки");
      return storeAds(req, false);
    }),
    route("POST", "api", "/olx/worker/import", async (req) => {
      await checkWorker(req);
      return storeAds(req, true);
    }),
    route("POST", "api", "/internal/olx/batch", async (req) => {
      if (!same(bearer(req), internal)) throw new HttpError(403, "Нет доступа");
      return storeAds(req, true);
    }),

    // Для часового сбора на GitHub: объявления, забранные после since, в формате выдачи OLX
    route("GET", "api", "/internal/olx/imports", (req) => {
      if (!same(bearer(req), internal)) throw new HttpError(403, "Нет доступа");
      const since = Date.parse(req.query.get("since") ?? "");
      const from = Number.isFinite(since) ? new Date(since).toISOString() : "";
      const afterId = Number(req.query.get("after_id") ?? 0);
      if (!Number.isSafeInteger(afterId) || afterId < 0) throw new HttpError(400, "Некорректный курсор");
      const rows = ctx.db
        .prepare("SELECT * FROM olx_ads WHERE (imported_at, id) > (?, ?) ORDER BY imported_at, id LIMIT 1000")
        .all(from, afterId) as unknown as Row[];
      return { json: { data: rows.map(asOffer) } };
    }),
  ];
}

/**
 * Закладка. Работает на открытой странице OLX: читает объявления, которые страница уже загрузила
 * (сначала window.__PRERENDERED_STATE__, иначе карточки списка), никаких запросов к OLX не делает,
 * открывает страницу /olx/ и передаёт ей список через postMessage. Телефон извлекает сервер из описания.
 */
export function bookmarklet(page: string): string {
  const origin = new URL(page).origin;
  const code = `(() => {
    const PAGE = ${JSON.stringify(page)}, ORIGIN = ${JSON.stringify(origin)}, OLX = "https://www.olx.kz/";
    const seen = new Map();
    const slim = (a) => {
      const id = Number(a.id), url = String(a.url || "");
      if (!id || !url.startsWith(OLX)) return;
      const p = (a.params || []).find((x) => x && x.key === "salary" && x.value && typeof x.value === "object");
      const v = p ? p.value : null;
      seen.set(id, { id, url, title: String(a.title || ""), description: String(a.description || ""),
        created_time: a.created_time || null, last_refresh_time: a.last_refresh_time || null, offer_type: a.offer_type || "offer",
        salary: v ? { from: v.from, to: v.to, currency: v.currency, type: v.type, arranged: v.arranged } : null,
        city: a.location && a.location.city ? a.location.city.name : null,
        map: a.map ? { lat: a.map.lat, lon: a.map.lon, show_detailed: a.map.show_detailed } : null });
    };
    const walk = (x, d) => {
      if (!x || typeof x !== "object" || d > 14) return;
      if (Array.isArray(x)) { for (const y of x) walk(y, d + 1); return; }
      if (typeof x.url === "string" && x.id !== undefined && x.title !== undefined && ("description" in x || "created_time" in x)) slim(x);
      for (const k in x) walk(x[k], d + 1);
    };
    try { let s = window.__PRERENDERED_STATE__; if (typeof s === "string") s = JSON.parse(s); walk(s, 0); } catch (e) {}
    if (!seen.size) {
      for (const c of document.querySelectorAll('[data-cy="l-card"]')) {
        const a = c.querySelector('a[href*="obyavlenie"]');
        if (!a) continue;
        const url = new URL(a.getAttribute("href"), location.href).href;
        const m = /-ID([A-Za-z0-9]+)\\.html/.exec(url);
        const id = Number(c.id) || (m ? parseInt(m[1], 36) : 0);
        const h = c.querySelector("h4,h6"), price = c.querySelector('[data-testid="ad-price"]'), loc = c.querySelector('[data-testid="location-date"]');
        const place = loc ? loc.textContent.trim() : "";
        if (id && url.startsWith(OLX)) seen.set(id, { id, url, title: h ? h.textContent.trim() : "",
          description: price ? "Зарплата: " + price.textContent.trim() : "", city: place.split(/[,\\-–]/)[0].trim() || null });
      }
    }
    const currentUrl = location.href.split("?")[0].split("#")[0];
    if (/\\/obyavlenie\\/rabota\\/[^/]+\\.html$/.test(currentUrl)) {
      const title = document.querySelector("h1");
      const heading = [...document.querySelectorAll("h2")].find((e) => /^описание$/i.test(e.textContent.trim()));
      const body = heading && heading.nextElementSibling;
      const idMatch = /\\bID:\\s*(\\d+)/.exec(document.body.innerText);
      const id = idMatch ? Number(idMatch[1]) : 0;
      const existing = seen.get(id);
      seen.clear();
      if (id && title && body) {
        const field = (label) => {
          const el = [...document.querySelectorAll("p")].find((e) => e.textContent.trim().toLowerCase() === label);
          return el && el.nextElementSibling ? el.nextElementSibling.textContent.trim() : "";
        };
        const salary = field("зарплата (тг.)");
        const city = field("местоположение").split(",")[0].trim();
        seen.set(id, { ...existing, id, url: currentUrl, title: title.textContent.trim(),
          description: body.innerText + (salary ? "\\nЗарплата: " + salary : ""), city: city || (existing && existing.city) || null });
      }
    }
    const items = [...seen.values()];
    if (!items.length) { alert("vacante: на этой странице не нашёл объявлений OLX. Откройте рубрику «Работа» или отдельную вакансию и дождитесь загрузки."); return; }
    const w = window.open(PAGE, "vacante-olx");
    if (!w) { alert("vacante: браузер не дал открыть окно. Разрешите всплывающие окна для olx.kz."); return; }
    const payload = { v: 1, page: location.href, items };
    const onMsg = (e) => { if (e.origin === ORIGIN && e.data === "vacante-ready") { w.postMessage(payload, ORIGIN); window.removeEventListener("message", onMsg); } };
    window.addEventListener("message", onMsg);
  })();`;
  return "javascript:" + encodeURIComponent(code.replace(/\s*\n\s*/g, " "));
}

function importPage(page: string) {
  const script = `
    const KEY = "vacante-olx-key";
    const $ = (id) => document.getElementById(id);
    const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const derive = async (pwd) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("olx:" + pwd)));
    const key = () => { try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; } };
    const showKey = () => { $("has-key").hidden = !key(); $("no-key").hidden = !!key(); };
    $("pwd-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const pwd = $("pwd").value;
      if (!pwd) return;
      try { localStorage.setItem(KEY, await derive(pwd)); } catch (err) { alert("Браузер не даёт сохранить ключ"); }
      $("pwd").value = "";
      showKey();
    });
    $("forget").addEventListener("click", () => { try { localStorage.removeItem(KEY); } catch (e) {} showKey(); });
    showKey();
    const status = (text, cls) => { const s = $("status"); s.textContent = text; s.className = cls || ""; };
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const salaryText = (s) => {
      if (!s || (s.from === undefined && s.to === undefined)) return "";
      const n = (v) => Number(v).toLocaleString("ru-RU");
      return (s.from !== undefined && s.to !== undefined ? n(s.from) + "–" + n(s.to) : s.from !== undefined ? "от " + n(s.from) : "до " + n(s.to)) + " " + (s.currency || "KZT");
    };
    const submit = async (items, page) => {
      $("list").innerHTML = items.map((a) => "<li><a href=\\"" + esc(a.url) + "\\" rel=\\"noopener\\" target=\\"_blank\\">" + esc(a.title || a.url) + "</a>" +
        (a.city ? " · " + esc(a.city) : "") + (salaryText(a.salary) ? " · " + esc(salaryText(a.salary)) : "") + "</li>").join("");
      $("result").hidden = false;
      if (!key()) { status("Сначала введите пароль админки выше, потом повторите.", "err"); return; }
      status("Отправляю " + items.length + " объявлений…");
      try {
        const r = await fetch("/olx/import", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key() },
          body: JSON.stringify({ items, page }) });
        const j = await r.json();
        if (!r.ok) { status("Не отправлено: " + (j.error || r.status), "err"); return; }
        status("Принято " + j.stored + " из " + j.received + (j.skipped ? " (" + j.skipped + " пропущено: не объявления OLX или резюме)" : "") +
          ". На сервере " + j.total + " объявлений за 30 дней. На сайте подходящие появятся после ближайшего часового сбора (в :17), " +
          "остаются только рабочие профессии и известные города.", "ok");
      } catch (err) { status("Не отправлено: " + err, "err"); }
    };
    window.addEventListener("message", (e) => {
      if (!${JSON.stringify(OLX_ORIGINS)}.includes(e.origin)) return;
      const data = e.data;
      if (!data || data.v !== 1 || !Array.isArray(data.items)) return;
      submit(data.items.slice(0, 300), data.page);
    });
    // Скопированная страница OLX (Ctrl+A, Ctrl+C на странице, Ctrl+V здесь): в буфере лежит разметка страницы,
    // из неё берём ссылки на объявления, названия, цены и города. Страницу у OLX при этом никто не запрашивает
    const fromHtml = (text) => {
      const doc = new DOMParser().parseFromString(text, "text/html");
      const seen = new Map();
      for (const a of doc.querySelectorAll('a[href*="obyavlenie"]')) {
        let url;
        try { url = new URL(a.getAttribute("href"), "https://www.olx.kz/").href; } catch (e) { continue; }
        url = url.split("#")[0].split("?")[0];
        if (!url.startsWith("https://www.olx.kz/") || !/\\.html$/.test(url)) continue;
        let card = a.closest('[data-cy="l-card"]');
        if (!card) {
          let el = a;
          card = a.parentElement || a;
          for (let i = 0; i < 6 && el.parentElement && el.parentElement !== doc.body; i++) {
            el = el.parentElement;
            if (/\\d\\s*(тг|₸|KZT)|Договорная/i.test(el.textContent) && el.querySelectorAll('a[href*="obyavlenie"]').length <= 2) { card = el; break; }
          }
        }
        const m = /-ID([A-Za-z0-9]+)\\.html$/.exec(url);
        const id = Number(card.id) || (m ? parseInt(m[1], 36) : 0);
        if (!id) continue;
        const h = card.querySelector("h1,h2,h3,h4,h5,h6");
        let title = (h ? h.textContent : a.textContent).replace(/\\s+/g, " ").trim();
        if (title.length > 120) title = a.textContent.replace(/\\s+/g, " ").trim().slice(0, 120);
        const priceEl = card.querySelector('[data-testid="ad-price"]');
        const price = priceEl ? priceEl.textContent : (/(\\d[\\d\\s\\u00a0]{2,}\\s*(?:тг|₸|KZT)\\.?)/i.exec(card.textContent) || [])[1];
        const locEl = card.querySelector('[data-testid="location-date"]');
        const city = locEl ? locEl.textContent.split(/[,\\-–]/)[0].trim() : "";
        const prev = seen.get(url);
        if (prev && prev.title && !title) continue;
        seen.set(url, { id, url, title, description: price ? "Зарплата: " + price.replace(/\\s+/g, " ").trim() : "", city: city || null });
      }
      return [...seen.values()].filter((x) => x.title);
    };
    window.vacanteFromHtml = fromHtml;
    document.addEventListener("paste", (e) => {
      if (e.target === $("pwd")) return;
      e.preventDefault();
      const h = e.clipboardData && e.clipboardData.getData("text/html");
      $("result").hidden = false;
      if (!h) { status("В буфере нет страницы. Откройте список на OLX, нажмите Ctrl+A и Ctrl+C, потом вставьте здесь.", "err"); return; }
      const items = fromHtml(h).slice(0, 300);
      const fallback = $("city").value;
      if (fallback) for (const x of items) if (!x.city) x.city = fallback;
      if (!items.length) { status("В скопированном не нашёл объявлений OLX. Скопируйте список рубрики «Работа» целиком: Ctrl+A на странице OLX, потом Ctrl+C.", "err"); return; }
      submit(items, "paste");
    });
    if (window.opener) window.opener.postMessage("vacante-ready", "*");
  `;
  return html`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>OLX → vacante.kz</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 720px; padding: 24px 16px; color: #1a1a1a; }
  h1 { font-size: 22px; }
  ol > li { margin-bottom: 20px; }
  .bm { display: inline-block; padding: 10px 18px; background: #2a6df4; color: #fff; border-radius: 8px; text-decoration: none; font-weight: 600; cursor: grab; }
  input { font: inherit; padding: 8px; width: 240px; max-width: 100%; }
  button { font: inherit; padding: 8px 14px; }
  .note { color: #555; font-size: 14px; }
  #status.ok { color: #137333; } #status.err { color: #b3261e; }
  #list { padding-left: 20px; font-size: 14px; }
  h2 { font-size: 18px; margin-top: 28px; }
  select { font: inherit; padding: 6px; }
  #paste { min-height: 72px; border: 2px dashed #9aa4b2; border-radius: 8px; padding: 12px; color: #555; outline: none; }
  #paste:empty::before { content: attr(data-placeholder); }
</style>
</head>
<body>
<h1>Вакансии с OLX → vacante.kz</h1>
<p class="note">OLX не пускает нашего робота, поэтому страницы OLX смотрите вы сами. Закладка читает только то, что уже видно на открытой странице, ничего у OLX не запрашивает и передаёт объявления сюда. Телефон из описания сохраняется для кнопки звонка в Vacante. Если номер скрыт за кнопкой OLX, импорт его не открывает.</p>
<ol>
  <li>
    <form id="pwd-form">
      <div id="no-key"><label>Пароль админки: <input id="pwd" type="password" autocomplete="current-password"></label> <button type="submit">Сохранить в этом браузере</button></div>
      <div id="has-key" hidden>Ключ сохранён в этом браузере. <button type="button" id="forget">Забыть</button></div>
    </form>
  </li>
  <li>Перетащите кнопку на панель закладок браузера: <a class="bm" href="${bookmarklet(page)}" onclick="alert('Перетащите эту кнопку на панель закладок, а нажимайте её уже на странице OLX');return false">Забрать в vacante</a></li>
  <li>Откройте на OLX рубрику «Работа» своего города (можно с фильтрами и на любой странице списка), дождитесь списка и нажмите закладку. Откроется эта страница с итогом.</li>
</ol>
<h2>Или без закладки: скопировать страницу</h2>
<p class="note">На странице OLX нажмите Ctrl+A (выделить всё) и Ctrl+C, вернитесь сюда и нажмите Ctrl+V. Так берутся названия, цены, города и ссылки, без текстов объявлений.</p>
<p><label>Город, если в объявлении он не указан: <select id="city"><option value="">не ставить</option><option>Алматы</option><option>Астана</option><option>Шымкент</option><option>Караганда</option><option>Актобе</option><option>Атырау</option><option>Актау</option><option>Павлодар</option><option>Усть-Каменогорск</option><option>Семей</option><option>Костанай</option><option>Уральск</option><option>Тараз</option><option>Туркестан</option><option>Петропавловск</option></select></label></p>
<div id="paste" contenteditable="true" data-placeholder="Вставьте сюда скопированную страницу OLX (Ctrl+V)"></div>
<div id="result" hidden>
  <p id="status"></p>
  <ul id="list"></ul>
</div>
<script>${raw(script)}</script>
</body>
</html>`;
}

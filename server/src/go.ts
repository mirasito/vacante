// Прямые кнопки связи: GET /go/<вакансия>/<wa|call|tg> сразу ведёт человека к работодателю — в чат WhatsApp
// с готовым текстом, на страницу звонка или в Telegram. Кнопки стоят на сайте, под постами в каналах
// и в подборках бота (vacante/launch.py, reply_buttons).
//
// Контакты берём из открытого поста в канале и храним на сервере (vacancy_contacts): при первом нажатии
// и заранее, фоновым сбором по вакансиям из CRM. В открытые данные сайта номера не попадают.
import { createHash, randomBytes } from "node:crypto";

import { clientIp } from "./admin-logins.ts";
import type { Db } from "./db.ts";
import { fetchPostContacts, type PostContacts } from "./contacts.ts";
import { escapeHtml as esc } from "./html.ts";
import { HttpError, route, type Request, type Route } from "./http.ts";
import { RateLimit } from "./limits.ts";
import { isPreviewBot } from "./page.ts";
import { iso } from "./seekers.ts";
import { DAY_MS, localDay } from "./time.ts";

/** id вакансии из канала: <канал>-<номер поста>. У hh-…, olx-… и bot-… свой отклик. */
const CHANNEL_VACANCY = /^([A-Za-z]\w{3,31})-(\d{1,10})$/;
const KINDS = { wa: "whatsapp", call: "phone", tg: "telegram" } as const;
type Kind = keyof typeof KINDS;
const SOURCE_RE = /^[a-z0-9]{1,8}$/;
/**
 * Сколько разных вакансий за день один посетитель может открыть кнопками, пока мы считаем его человеком.
 * Роботы, которые выдают себя за браузер, обходят все кнопки сайта подряд (17, 18 и 23 ноября — по 2,6–4 тыс.
 * нажатий, почти ровно по одному на кнопку); человек столько разных работодателей за день не открывает.
 */
export const ROBOT_VACANCIES = 15;
/** Сколько новых постов в минуту читаем с t.me по нажатиям: остальные нажатия уходят на исходный пост. */
const FETCH_PER_MINUTE = 60;

export interface Deps {
  db: Db;
  fetch: typeof fetch;
  now: () => number;
}

const postUrl = (id: string): string | null => {
  const m = CHANNEL_VACANCY.exec(id);
  return m ? `https://t.me/${m[1]}/${m[2]}` : null;
};

function stored(db: Db, id: string, now: number): PostContacts | "miss" | undefined {
  const row = db.prepare("SELECT whatsapp, phone, telegram, found, checked_at FROM vacancy_contacts WHERE vacancy_id = ?").get(id) as
    | { whatsapp: string | null; phone: string | null; telegram: string | null; found: number; checked_at: string }
    | undefined;
  if (!row) return undefined;
  if (row.found) return { whatsapp: row.whatsapp, phone: row.phone, telegram: row.telegram };
  // «Не нашли» помним сутки: пост могли поправить или временно не отдать
  return now - Date.parse(row.checked_at) < DAY_MS ? "miss" : undefined;
}

function save(db: Db, id: string, c: PostContacts | null, now: number): void {
  const found = c && (c.whatsapp || c.phone || c.telegram) ? 1 : 0;
  db.prepare(
    `INSERT INTO vacancy_contacts (vacancy_id, whatsapp, phone, telegram, found, checked_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (vacancy_id) DO UPDATE SET whatsapp = excluded.whatsapp, phone = excluded.phone,
       telegram = excluded.telegram, found = excluded.found, checked_at = excluded.checked_at`,
  ).run(id, c?.whatsapp ?? null, c?.phone ?? null, c?.telegram ?? null, found, iso(now));
}

/** Читает пост вакансии на t.me и сохраняет его контакты. Ошибку сети не сохраняет: спросим в другой раз. */
async function lookup(deps: Deps, id: string, url: string): Promise<PostContacts | null> {
  let found: PostContacts | null;
  try {
    found = await fetchPostContacts(deps.fetch, url);
  } catch {
    return null;
  }
  save(deps.db, id, found, deps.now());
  return found;
}

/**
 * Фоновый сбор: контакты вакансий из каналов, которые сейчас на сайте (их список присылает сбор в CRM)
 * и про которые ещё ничего не сохранено. По порции за проход, с паузой между постами. Возвращает,
 * сколько постов прочитано.
 */
export async function backfillContacts(deps: Deps, limit = 30, pauseMs = 1_000): Promise<number> {
  const day = iso(deps.now() - DAY_MS);
  const ids = deps.db
    .prepare(
      `SELECT v.id FROM employer_vacancies v
       LEFT JOIN vacancy_contacts c ON c.vacancy_id = v.id
       WHERE v.active = 1 AND v.source = 'telegram' AND (c.vacancy_id IS NULL OR (c.found = 0 AND c.checked_at < ?))
       ORDER BY v.posted_at DESC LIMIT ?`,
    )
    .all(day, limit) as { id: string }[];
  let read = 0;
  for (const { id } of ids) {
    const url = postUrl(id);
    if (!url) continue;
    if (read && pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    let found: PostContacts | null;
    try {
      found = await fetchPostContacts(deps.fetch, url);
    } catch {
      break; // t.me не отвечает: продолжим в следующий проход
    }
    save(deps.db, id, found, deps.now());
    read++;
  }
  return read;
}

/** Планировщик фонового сбора в процессе сервера: раз в 5 минут, проходы не накладываются. */
export function startContactsBackfill(deps: Deps, everyMs = 5 * 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const read = await backfillContacts(deps);
      if (read) console.log(`контакты вакансий: прочитано постов ${read}`);
    } catch (err) {
      console.error(`контакты вакансий: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, everyMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

/**
 * Отличает обход роботом от людей без журнала адресов. Посетитель — хэш адреса и браузера с солью дня;
 * соль и хэши живут только в памяти сервера и пропадают в конце дня, в базу ничего из этого не пишется.
 */
export class RobotGuard {
  private day = "";
  private salt = Buffer.alloc(0);
  private seen = new Map<string, Set<string>>();

  /** true — этот посетитель за сегодня открыл кнопки больше чем у ROBOT_VACANCIES разных вакансий. */
  check(visitor: string, vacancyId: string, now: number): boolean {
    const day = localDay(now);
    if (day !== this.day) {
      this.day = day;
      this.salt = randomBytes(16);
      this.seen.clear();
    }
    const key = createHash("sha256").update(this.salt).update(visitor).digest("base64url").slice(0, 16);
    let ids = this.seen.get(key);
    if (!ids) {
      if (this.seen.size > 50_000) this.seen.clear();
      ids = new Set();
      this.seen.set(key, ids);
    }
    if (ids.size <= ROBOT_VACANCIES) ids.add(vacancyId);
    return ids.size > ROBOT_VACANCIES;
  }
}

const visitorOf = (req: Request) => `${clientIp(req)}\n${req.header("user-agent") ?? ""}`;

function countClick(db: Db, source: string, kind: Kind | "miss" | "robot", now: number): void {
  db.prepare(
    `INSERT INTO contact_clicks (day, source, kind, n) VALUES (?, ?, ?, 1)
     ON CONFLICT (day, source, kind) DO UPDATE SET n = n + 1`,
  ).run(localDay(now), source, kind);
}

/** Нажатия на кнопки связи за дни from…to включительно. */
export function contactClicks(db: Db, from: string, to: string): { day: string; source: string; kind: string; n: number }[] {
  const rows = db
    .prepare("SELECT day, source, kind, n FROM contact_clicks WHERE day BETWEEN ? AND ? ORDER BY day DESC, source, kind")
    .all(from, to) as { day: string; source: string; kind: string; n: number }[];
  return rows.map((r) => ({ day: r.day, source: r.source || "—", kind: r.kind, n: Number(r.n) }));
}

/** Название вакансии для готового текста: одна строка без разметки, не длиннее 80 знаков. */
function cleanTitle(raw: string | null): string {
  return (raw ?? "")
    .replace(/[<>«»"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
}

const greeting = (title: string) =>
  title ? `Здравствуйте! Пишу по вакансии «${title}». Нашёл её на vacante.kz` : "Здравствуйте! Пишу по вакансии. Нашёл её на vacante.kz";

/** +77011234567 → +7 701 123 45 67 */
const pretty = (phone: string) => phone.replace(/^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/, "+7 $1 $2 $3 $4");

function callPage(phone: string, title: string, back: string): string {
  const tel = esc(phone);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="refresh" content="0;url=tel:${tel}">
<title>Позвонить работодателю — vacante.kz</title>
<style>
body{font:17px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;padding:32px 20px;color:#16202a;background:#f6f8f9;text-align:center}
main{max-width:420px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}
.num{font-size:30px;font-weight:700;margin:20px 0;letter-spacing:.5px}
a.call{display:block;background:#0f9d8f;color:#fff;text-decoration:none;font-weight:700;padding:16px;border-radius:999px}
a.back{display:inline-block;margin-top:20px;color:#5b6b78}
@media (prefers-color-scheme:dark){body{background:#12181d;color:#eef2f4}a.back{color:#9fb0bc}}
</style></head><body><main>
<h1>Звонок работодателю</h1>
${title ? `<p>${esc(title)}</p>` : ""}
<p class="num">${esc(pretty(phone))}</p>
<a class="call" href="tel:${tel}">📞 Позвонить</a>
<a class="back" href="${esc(back)}">Открыть объявление</a>
</main></body></html>`;
}

export function goRoutes(ctx: Deps): Route[] {
  const fetches = new RateLimit(FETCH_PER_MINUTE, 60_000);
  const robots = new RobotGuard();
  const noindex = { "X-Robots-Tag": "noindex, nofollow" };

  return [
    route("GET", "api", "/go/:id/:kind", async (req) => {
      const id = req.params.id ?? "";
      const kind = req.params.kind as Kind;
      const url = postUrl(id);
      if (!url || !Object.hasOwn(KINDS, kind)) throw new HttpError(404, "Не найдено");
      const now = ctx.now();
      const tag = req.query.get("s") ?? "";
      const source = SOURCE_RE.test(tag) ? tag : "";
      // Поисковые и другие роботы: не считаем нажатие и не отдаём номер, ведём к объявлению
      if (isPreviewBot(req.header("user-agent"))) return { status: 302, headers: { ...noindex, Location: url } };
      // Робот под видом браузера обходит все кнопки подряд: считаем отдельно и номер не отдаём
      if (robots.check(visitorOf(req), id, now)) {
        countClick(ctx.db, source, "robot", now);
        return { status: 302, headers: { ...noindex, Location: url } };
      }

      let contacts = stored(ctx.db, id, now);
      if (contacts === undefined && fetches.take("t.me", now)) contacts = (await lookup(ctx, id, url)) ?? "miss";
      const value = contacts && contacts !== "miss" ? contacts[KINDS[kind]] : null;
      if (!value) {
        // Контакта нет, пост удалён или t.me не ответил: человек всё равно попадает к объявлению
        countClick(ctx.db, source, "miss", now);
        return { status: 302, headers: { ...noindex, Location: url } };
      }
      countClick(ctx.db, source, kind, now);
      const title = cleanTitle(req.query.get("t"));
      if (kind === "wa") {
        const to = `https://wa.me/${value.replace(/\D/g, "")}?text=${encodeURIComponent(greeting(title))}`;
        return { status: 302, headers: { ...noindex, Location: to } };
      }
      if (kind === "tg") return { status: 302, headers: { ...noindex, Location: `https://t.me/${encodeURIComponent(value)}` } };
      return { headers: noindex, html: callPage(value, title, url) };
    }),
  ];
}

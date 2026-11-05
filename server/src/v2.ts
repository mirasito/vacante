// vacante 2.0: удобное время для собеседования, «Не смогу прийти», «пришёл/не пришёл» и надёжность,
// переписка с работодателем, отзывы о заведениях, приглашения друзей, выгрузка своих данных и жалобы.
// Соискатель делает всё это в приложении (адреса /me/…), работодатель отвечает на странице профиля
// по ссылке отклика (page.ts): номера и аккаунты работодателей мы по-прежнему не храним.
import { randomBytes } from "node:crypto";

import type { Ctx } from "./app.ts";
import { applicationView, ensureLink, getApplication, listApplications, parseSlots, type ApplicationRow } from "./applications.ts";
import { tx, type Db } from "./db.ts";
import { HttpError, route, type Request, type Route } from "./http.ts";
import { RateLimit } from "./limits.ts";
import { listReminders, getSettings } from "./reminders.ts";
import { getSeeker, iso, listViews, profileView, randomCode } from "./seekers.ts";
import { internalKey } from "./telegram.ts";
import { DAY_MS } from "./time.ts";

const bad = (message: string) => new HttpError(400, message);

/* ---------- Удобное время и отмена ---------- */

export const MAX_SLOTS = 3;

/** До трёх моментов: не в прошлом и не дальше 60 дней. Повторы и порядок поправляем сами. */
export function parseSlotList(body: unknown, now: number): string[] {
  const list = (body as { slots?: unknown } | null)?.slots;
  if (!Array.isArray(list) || list.length > MAX_SLOTS) throw bad(`Поле slots: до ${MAX_SLOTS} вариантов времени`);
  const out = new Set<string>();
  for (const x of list) {
    const ms = typeof x === "string" && /^\d{4}-\d{2}-\d{2}T/.test(x) ? Date.parse(x) : NaN;
    if (Number.isNaN(ms) || ms < now - 3_600_000 || ms > now + 60 * DAY_MS) throw bad("Поле slots: проверьте дату и время");
    out.add(iso(ms));
  }
  return [...out].sort();
}

export function setSlots(db: Db, app: ApplicationRow, slots: string[], now: number) {
  db.prepare("UPDATE applications SET slots = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(slots), iso(now), app.id);
}

/** Удобное время, которое ещё не прошло: его работодатель видит кнопками. */
export const futureSlots = (app: ApplicationRow, now: number) => parseSlots(app.slots).filter((s) => Date.parse(s) > now);

/**
 * «Не смогу прийти»: собеседование снимается, отклик снова ждёт времени, а работодатель видит
 * сообщение в переписке. Предупредить заранее не считается неявкой.
 */
export function cancelInterview(db: Db, app: ApplicationRow, text: string, now: number) {
  tx(db, () => {
    const at = iso(now);
    db.prepare(
      `UPDATE applications SET cancelled_at = ?, interview_at = NULL, stage = 'invited', attended = NULL, attended_by = NULL,
         updated_at = ? WHERE id = ?`,
    ).run(at, at, app.id);
    if (app.stage !== "invited") {
      db.prepare("INSERT INTO application_events (application_id, stage, by, at) VALUES (?, 'invited', 'seeker', ?)").run(app.id, at);
    }
    addMessage(db, app.id, "seeker", text, now);
  });
}

/* ---------- «Пришёл / не пришёл» и надёжность ---------- */

/** Отметить явку можно, когда собеседование уже началось. Отметка работодателя главнее. */
export function canMark(app: ApplicationRow, now: number) {
  return !!app.interview_at && Date.parse(app.interview_at) <= now && !app.cancelled_at;
}

export function markAttended(db: Db, app: ApplicationRow, value: "yes" | "no", by: "seeker" | "employer", now: number): boolean {
  if (!canMark(app, now)) return false;
  if (by === "seeker" && app.attended_by === "employer") return false;
  if (app.attended === value && app.attended_by === by) return false;
  db.prepare("UPDATE applications SET attended = ?, attended_by = ?, updated_at = ? WHERE id = ?").run(value, by, iso(now), app.id);
  return true;
}

export const LEVELS = ["bronze", "silver", "gold"] as const;
export type Level = (typeof LEVELS)[number];

export interface Reliability {
  level: Level | null;
  /** Сколько собеседований с отметкой: пришёл, не пришёл, и сколько отменено заранее. */
  attended: number;
  missed: number;
  cancelled: number;
  /** Что нужно до следующего уровня: столько ещё прийти без неявок. */
  next: { level: Level; need: number } | null;
}

/**
 * Уровень надёжности по отметкам «пришёл/не пришёл», самые свежие первыми.
 * Бронза — пришёл хоть раз; серебро — 3 явки и ни одной неявки среди последних пяти;
 * золото — 8 явок и ни одной неявки среди последних десяти.
 */
export function reliability(db: Db, seekerId: number): Reliability {
  const rows = db
    .prepare(
      `SELECT attended FROM applications WHERE seeker_id = ? AND attended IS NOT NULL ORDER BY interview_at DESC, id DESC`,
    )
    .all(seekerId) as { attended: "yes" | "no" }[];
  const { n: cancelled } = db
    .prepare("SELECT COUNT(*) AS n FROM applications WHERE seeker_id = ? AND cancelled_at IS NOT NULL")
    .get(seekerId) as { n: number };
  const attended = rows.filter((r) => r.attended === "yes").length;
  const missed = rows.length - attended;
  const clean = (last: number) => !rows.slice(0, last).some((r) => r.attended === "no");
  const level: Level | null =
    attended >= 8 && clean(10) ? "gold" : attended >= 3 && clean(5) ? "silver" : attended >= 1 ? "bronze" : null;
  const next: Reliability["next"] =
    level === "gold"
      ? null
      : level === "silver"
        ? { level: "gold", need: Math.max(1, 8 - attended) }
        : level === "bronze"
          ? { level: "silver", need: Math.max(1, 3 - attended) }
          : { level: "bronze", need: 1 };
  return { level, attended, missed, cancelled: Number(cancelled), next };
}

/* ---------- Переписка ---------- */

export const MAX_MESSAGE = 1000;

export interface Message {
  id: number;
  by: "seeker" | "employer";
  text: string;
  at: string;
  read_at: string | null;
}

export function cleanMessage(value: unknown): string {
  if (typeof value !== "string") throw bad("Нужен текст сообщения");
  const text = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) throw bad("Нужен текст сообщения");
  return text.slice(0, MAX_MESSAGE);
}

export function addMessage(db: Db, applicationId: number, by: "seeker" | "employer", text: string, now: number): Message {
  const at = iso(now);
  const { lastInsertRowid } = db
    .prepare("INSERT INTO messages (application_id, by, text, at) VALUES (?, ?, ?, ?)")
    .run(applicationId, by, text, at);
  db.prepare("UPDATE applications SET updated_at = ? WHERE id = ?").run(at, applicationId);
  return { id: Number(lastInsertRowid), by, text, at, read_at: null };
}

export function listMessages(db: Db, applicationId: number): Message[] {
  return db
    .prepare("SELECT id, by, text, at, read_at FROM messages WHERE application_id = ? ORDER BY at, id")
    .all(applicationId) as unknown as Message[];
}

/** Прочитаны сообщения другой стороны: соискатель открыл чат или работодатель — страницу. */
export function markRead(db: Db, applicationId: number, from: "seeker" | "employer", now: number) {
  db.prepare("UPDATE messages SET read_at = ? WHERE application_id = ? AND by = ? AND read_at IS NULL").run(
    iso(now), applicationId, from,
  );
}

/** Сколько сообщений одна сторона может написать подряд без ответа: защита от спама в обе стороны. */
export const MAX_UNANSWERED = 10;

export function unanswered(db: Db, applicationId: number, by: "seeker" | "employer"): number {
  const rows = db
    .prepare("SELECT by FROM messages WHERE application_id = ? ORDER BY at DESC, id DESC LIMIT ?")
    .all(applicationId, MAX_UNANSWERED) as { by: string }[];
  let n = 0;
  for (const r of rows) {
    if (r.by !== by) break;
    n++;
  }
  return n;
}

/* ---------- Отзывы ---------- */

export const REVIEW_TAGS = ["polite", "on_time", "as_described", "clean", "late", "rude", "different_pay"] as const;
/** Отзывы показываем только когда их три и больше: по одному отзыву легко узнать автора. */
export const MIN_REVIEWS = 3;

export const venueKey = (employer: string) => employer.trim().replace(/\s+/g, " ").toLowerCase();

export function parseReview(body: unknown): { stars: number; tags: string[]; text: string | null } {
  const b = (body ?? {}) as Record<string, unknown>;
  const stars = Number(b.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw bad("Поле stars: от 1 до 5");
  const tags = Array.isArray(b.tags) ? REVIEW_TAGS.filter((t) => (b.tags as unknown[]).includes(t)) : [];
  const text = typeof b.text === "string" && b.text.trim() ? cleanMessage(b.text).slice(0, 500) : null;
  return { stars, tags, text };
}

export function saveReview(db: Db, app: ApplicationRow, r: ReturnType<typeof parseReview>, now: number) {
  db.prepare(
    `INSERT INTO reviews (application_id, venue, city, stars, tags, text, at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (application_id) DO UPDATE SET stars = excluded.stars, tags = excluded.tags, text = excluded.text, at = excluded.at`,
  ).run(app.id, venueKey(app.employer ?? ""), app.city, r.stars, JSON.stringify(r.tags), r.text, iso(now));
}

export interface VenueReviews {
  count: number;
  stars: number | null;
  tags: { tag: string; n: number }[];
}

/** Сводка по заведению: средняя оценка и частые метки. Тексты отзывов наружу не идут. */
export function venueReviews(db: Db, employer: string): VenueReviews {
  const rows = db.prepare("SELECT stars, tags FROM reviews WHERE venue = ?").all(venueKey(employer)) as {
    stars: number;
    tags: string;
  }[];
  if (rows.length < MIN_REVIEWS) return { count: rows.length, stars: null, tags: [] };
  const counts = new Map<string, number>();
  for (const r of rows) for (const t of parseSlots(r.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const stars = Math.round((rows.reduce((s, r) => s + r.stars, 0) / rows.length) * 10) / 10;
  const tags = [...counts].map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n).slice(0, 5);
  return { count: rows.length, stars, tags };
}

/* ---------- Приглашения ---------- */

export const REF_RE = /^[a-z0-9]{6}$/;

export function refCode(db: Db, seekerId: number): string {
  const row = db.prepare("SELECT ref_code FROM seekers WHERE id = ?").get(seekerId) as { ref_code: string | null };
  if (row.ref_code) return row.ref_code;
  for (;;) {
    const code = randomBytes(6).toString("base64").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 6);
    if (!REF_RE.test(code)) continue;
    try {
      db.prepare("UPDATE seekers SET ref_code = ? WHERE id = ?").run(code, seekerId);
      return code;
    } catch {
      // такой код уже есть: пробуем другой
    }
  }
}

export const invitedCount = (db: Db, seekerId: number) =>
  Number((db.prepare("SELECT COUNT(*) AS n FROM seekers WHERE referred_by = ?").get(seekerId) as { n: number }).n);

/**
 * Кто пригласил: записывается один раз, только в первую неделю после создания профиля и не самим себе.
 * true, если записали.
 */
export function setReferrer(db: Db, seekerId: number, code: string, now: number): boolean {
  if (!REF_RE.test(code)) return false;
  const me = db.prepare("SELECT referred_by, created_at FROM seekers WHERE id = ?").get(seekerId) as
    | { referred_by: number | null; created_at: string }
    | undefined;
  if (!me || me.referred_by || Date.parse(me.created_at) < now - 7 * DAY_MS) return false;
  const ref = db.prepare("SELECT id FROM seekers WHERE ref_code = ?").get(code) as { id: number } | undefined;
  if (!ref || ref.id === seekerId) return false;
  db.prepare("UPDATE seekers SET referred_by = ? WHERE id = ?").run(ref.id, seekerId);
  return true;
}

/* ---------- Выгрузка данных ---------- */

/** Всё, что сервер знает о человеке, одним файлом JSON: анкета, отклики с историей и перепиской, напоминания, отзывы. */
export function exportData(ctx: Ctx, seekerId: number) {
  const now = ctx.now();
  const origin = ctx.config.profileOrigin;
  const seeker = getSeeker(ctx.db, seekerId);
  const applications = listApplications(ctx.db, seekerId, origin, now).map((a) => ({
    ...applicationView(ctx.db, seekerId, a.id, origin, now),
    chat: listMessages(ctx.db, a.id),
  }));
  const reviews = ctx.db
    .prepare(
      `SELECT r.application_id, r.stars, r.tags, r.text, r.at FROM reviews r JOIN applications a ON a.id = r.application_id
       WHERE a.seeker_id = ?`,
    )
    .all(seekerId);
  return {
    exported_at: iso(now),
    service: "vacante.kz",
    account: seeker,
    profile: profileView(ctx.db, seekerId, origin),
    applications,
    reminders: { ...listReminders(ctx.db, seekerId, now), settings: getSettings(ctx.db, seekerId) },
    views: listViews(ctx.db, seekerId, 1000),
    reviews,
    reliability: reliability(ctx.db, seekerId),
    invited: invitedCount(ctx.db, seekerId),
  };
}

/* ---------- Адреса ---------- */

export function v2Routes(ctx: Ctx): Route[] {
  const seekerOf = (req: Request) => {
    const { user } = ctx.auth(req);
    const seeker = getSeeker(ctx.db, user.id);
    if (!seeker) throw new HttpError(404, "Профиля ещё нет");
    return seeker;
  };
  const appOf = (req: Request) => {
    const seeker = seekerOf(req);
    const id = Number(req.params.id);
    const app = Number.isSafeInteger(id) && id > 0 ? getApplication(ctx.db, seeker.id, id) : undefined;
    if (!app) throw new HttpError(404, "Отклика нет");
    return app;
  };
  const origin = ctx.config.profileOrigin;
  const view = (app: ApplicationRow) => applicationView(ctx.db, app.seeker_id, app.id, origin, ctx.now());
  // Сообщения: 30 в час на человека; жалобы: 10 в час; выгрузка: 5 в час
  const messages = new RateLimit(30, 3_600_000);
  const reports = new RateLimit(10, 3_600_000);
  const exports = new RateLimit(5, 3_600_000);
  /** Ссылки на выгрузку: живут 10 минут, только в памяти сервера. */
  const tokens = new Map<string, { seeker: number; until: number }>();

  return [
    // Удобное время: до трёх вариантов, работодатель увидит их кнопками на странице профиля
    route("PUT", "api", "/me/applications/:id/slots", async (req) => {
      const app = appOf(req);
      const now = ctx.now();
      setSlots(ctx.db, app, parseSlotList(await req.json(), now), now);
      ensureLink(ctx.db, app.seeker_id, app.id, now);
      return { json: { application: view(app) } };
    }),

    // «Не смогу прийти»: с предупреждением работодателю в переписке
    route("POST", "api", "/me/applications/:id/cancel", async (req) => {
      const app = appOf(req);
      const body = ((await req.json<Record<string, unknown>>()) ?? {}) as Record<string, unknown>;
      if (app.stage !== "interview" && app.stage !== "invited") throw new HttpError(409, "Собеседования нет");
      const text = cleanMessage(typeof body.text === "string" && body.text.trim() ? body.text : "Не смогу прийти на собеседование.");
      cancelInterview(ctx.db, app, text, ctx.now());
      return { json: { application: view(app) } };
    }),

    // «Я пришёл» / «Не получилось»: после начала собеседования
    route("PUT", "api", "/me/applications/:id/attended", async (req) => {
      const app = appOf(req);
      const body = ((await req.json<Record<string, unknown>>()) ?? {}) as Record<string, unknown>;
      if (body.attended !== "yes" && body.attended !== "no") throw bad("Поле attended: yes или no");
      if (!canMark(app, ctx.now())) throw new HttpError(409, "Отметить можно после начала собеседования");
      markAttended(ctx.db, app, body.attended, "seeker", ctx.now());
      return { json: { application: view(app), reliability: reliability(ctx.db, app.seeker_id) } };
    }),

    route("GET", "api", "/me/reliability", (req) => ({ json: reliability(ctx.db, seekerOf(req).id) })),

    // Чаты: отклики с перепиской или с живой ссылкой, где работодатель может ответить
    route("GET", "api", "/me/chats", (req) => {
      const seeker = seekerOf(req);
      const now = ctx.now();
      const list = listApplications(ctx.db, seeker.id, origin, now).filter(
        (a) => a.messages > 0 || (a.link && a.stage !== "liked"),
      );
      const last = ctx.db.prepare("SELECT by, text, at FROM messages WHERE application_id = ? ORDER BY at DESC, id DESC LIMIT 1");
      return {
        json: {
          chats: list.map((a) => ({ application: a, last: last.get(a.id) ?? null })),
          unread: list.reduce((s, a) => s + a.unread, 0),
        },
      };
    }),

    route("GET", "api", "/me/applications/:id/messages", (req) => {
      const app = appOf(req);
      markRead(ctx.db, app.id, "employer", ctx.now());
      return { json: { messages: listMessages(ctx.db, app.id), application: view(app) } };
    }),

    // Сообщение работодателю: он увидит его на странице профиля по ссылке отклика
    route("POST", "api", "/me/applications/:id/messages", async (req) => {
      const app = appOf(req);
      const now = ctx.now();
      if (!messages.take(String(app.seeker_id), now)) throw new HttpError(429, "Слишком часто, подождите немного");
      const body = ((await req.json<Record<string, unknown>>()) ?? {}) as Record<string, unknown>;
      const text = cleanMessage(body.text);
      if (unanswered(ctx.db, app.id, "seeker") >= MAX_UNANSWERED) throw new HttpError(429, "Дождитесь ответа работодателя");
      const link = ensureLink(ctx.db, app.seeker_id, app.id, now);
      const message = addMessage(ctx.db, app.id, "seeker", text, now);
      return { status: 201, json: { message, link: `${origin}/${link}` } };
    }),

    // Отзыв о заведении после собеседования
    route("PUT", "api", "/me/applications/:id/review", async (req) => {
      const app = appOf(req);
      if (!app.employer) throw new HttpError(409, "У вакансии нет названия заведения");
      if (!app.interview_at || Date.parse(app.interview_at) > ctx.now()) throw new HttpError(409, "Отзыв можно оставить после собеседования");
      saveReview(ctx.db, app, parseReview(await req.json()), ctx.now());
      return { json: { application: view(app) } };
    }),

    // Сводка отзывов для страницы заведения: без входа, только числа
    route("GET", "api", "/venues/reviews", (req) => {
      const name = (req.query.get("name") ?? "").slice(0, 120);
      if (!name.trim()) throw bad("Нужно название заведения");
      return { json: venueReviews(ctx.db, name), headers: { "Cache-Control": "public, max-age=600" } };
    }),

    // «Пригласить друга»: свой код и сколько друзей пришло
    route("GET", "api", "/me/referral", (req) => {
      const seeker = seekerOf(req);
      const code = refCode(ctx.db, seeker.id);
      return {
        json: { code, url: `https://t.me/${ctx.config.botUsername}?startapp=ref_${code}`, invited: invitedCount(ctx.db, seeker.id) },
      };
    }),

    route("POST", "api", "/me/referral", async (req) => {
      const seeker = seekerOf(req);
      const body = ((await req.json<Record<string, unknown>>()) ?? {}) as Record<string, unknown>;
      const ok = typeof body.code === "string" && setReferrer(ctx.db, seeker.id, body.code, ctx.now());
      return { json: { ok } };
    }),

    // «Скачать мои данные»: короткая ссылка на файл, её открывает Telegram или браузер
    route("POST", "api", "/me/export", (req) => {
      const seeker = seekerOf(req);
      const now = ctx.now();
      if (!exports.take(String(seeker.id), now)) throw new HttpError(429, "Слишком часто, подождите немного");
      for (const [k, v] of tokens) if (v.until < now) tokens.delete(k);
      const token = randomCode() + randomCode() + randomCode();
      tokens.set(token, { seeker: seeker.id, until: now + 10 * 60_000 });
      return { status: 201, json: { url: `${ctx.config.apiOrigin}/export/${token}` } };
    }),

    route("GET", "api", "/export/:token", (req) => {
      const entry = tokens.get(req.params.token ?? "");
      if (!entry || entry.until < ctx.now() || !getSeeker(ctx.db, entry.seeker)) throw new HttpError(404, "Ссылка устарела");
      const body = Buffer.from(JSON.stringify(exportData(ctx, entry.seeker), null, 2));
      return {
        body,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": 'attachment; filename="vacante-data.json"',
        },
      };
    }),

    // Жалоба на вакансию: уходит модераторам в бот. Профиль не нужен
    route("POST", "api", "/me/report", async (req) => {
      const { user } = ctx.auth(req);
      const now = ctx.now();
      if (!reports.take(String(user.id), now)) throw new HttpError(429, "Слишком часто, подождите немного");
      const b = ((await req.json<Record<string, unknown>>()) ?? {}) as Record<string, unknown>;
      const reason = typeof b.reason === "string" && REPORT_REASONS.includes(b.reason as never) ? b.reason : "other";
      const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
      const report = {
        vacancy_id: str(b.vacancy_id, 100),
        title: str(b.title, 120),
        employer: str(b.employer, 120),
        url: /^https:\/\/vacante\.kz\//.test(str(b.url, 300)) ? str(b.url, 300) : "",
        reason,
        text: str(b.text, 500),
        from: user.id,
      };
      if (!report.vacancy_id) throw bad("Нужна вакансия");
      ctx.background(sendReport(ctx, report));
      return { status: 202, json: { ok: true } };
    }),
  ];
}

export const REPORT_REASONS = ["fraud", "prepay", "contacts", "closed", "wrong", "other"] as const;

/** Жалобу принимает бот на Cloudflare: только у него список модераторов. */
async function sendReport(ctx: Ctx, report: Record<string, unknown>) {
  try {
    const res = await ctx.fetch(`${ctx.config.botUrl}/internal/report`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${internalKey(ctx.config.botToken)}` },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.warn(`жалоба: бот ответил ${res.status}`);
  } catch (err) {
    console.warn(`жалоба не ушла: ${err instanceof Error ? err.message : err}`);
  }
}

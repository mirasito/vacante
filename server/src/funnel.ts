// Воронка перезапуска: открыл приложение → начал анкету → создал профиль → отправил отклик →
// работодатель открыл ссылку → работодатель ответил, по дням и по метке источника из ссылки запуска.
//
// До согласия о человеке ничего не хранится, поэтому первые два шага — обезличенные счётчики
// (funnel_counts), а повторы за день отсекаются в памяти процесса и на диск не попадают.
import { timingSafeEqual } from "node:crypto";

import type { Ctx } from "./app.ts";
import type { Db } from "./db.ts";
import { HttpError, route, type Request, type Route } from "./http.ts";
import { getSeeker, iso } from "./seekers.ts";
import { DAY_MS, localDay } from "./time.ts";

export const STEPS = ["open", "profile_start", "sent_plain"] as const;
export type Step = (typeof STEPS)[number];

const SOURCE_RE = /^[a-z0-9]{1,8}$/;
/** Метка источника из приложения или null, если её нет или она не по формату ссылки запуска. */
export const sourceOf = (value: unknown): string | null => (typeof value === "string" && SOURCE_RE.test(value) ? value : null);

export function countStep(db: Db, step: Step, source: string | null, now: number): void {
  db.prepare(
    `INSERT INTO funnel_counts (day, source, step, n) VALUES (?, ?, ?, 1)
     ON CONFLICT (day, source, step) DO UPDATE SET n = n + 1`,
  ).run(localDay(now), source ?? "", step);
}

/** Первая метка источника остаётся навсегда: следующие ссылки её не меняют. */
export function attachSource(db: Db, seekerId: number, source: string | null, now: number): void {
  if (!source) return;
  db.prepare("UPDATE seekers SET source = ?, source_at = ? WHERE id = ? AND source IS NULL").run(source, iso(now), seekerId);
}

export interface FunnelRow {
  day: string;
  source: string;
  opened: number;
  profile_started: number;
  profile_done: number;
  /** Отклики без профиля: человек отказался от анкеты и отправил короткий текст без ссылки. */
  sent_plain: number;
  sent: number;
  sent_with_link: number;
  reached: number;
  answered: number;
}

const NUMBERS = ["opened", "profile_started", "profile_done", "sent_plain", "sent", "sent_with_link", "reached", "answered"] as const;
type Field = (typeof NUMBERS)[number];
const NO_SOURCE = "—";
// День по времени Казахстана (UTC+5) из времени в базе
const DAY = (column: string) => `date(${column}, '+5 hours')`;

const blank = (day: string, source: string): FunnelRow => ({
  day, source, opened: 0, profile_started: 0, profile_done: 0, sent_plain: 0, sent: 0, sent_with_link: 0, reached: 0, answered: 0,
});

/** Воронка за дни from…to включительно (ГГГГ-ММ-ДД по времени Казахстана), строка на день и источник. */
export function funnel(db: Db, from: string, to: string): FunnelRow[] {
  const rows = new Map<string, FunnelRow>();
  const add = (day: string, source: string | null, field: Field, n: number) => {
    const label = source || NO_SOURCE;
    const key = `${day}|${label}`;
    let row = rows.get(key);
    if (!row) rows.set(key, (row = blank(day, label)));
    row[field] += n;
  };
  type Counted = { day: string; source: string | null; n: number };
  const each = (sql: string, field: Field) => {
    for (const r of db.prepare(sql).all(from, to) as unknown as Counted[]) add(r.day, r.source, field, Number(r.n));
  };

  each("SELECT day, source, n FROM funnel_counts WHERE step = 'open' AND day BETWEEN ? AND ?", "opened");
  each("SELECT day, source, n FROM funnel_counts WHERE step = 'profile_start' AND day BETWEEN ? AND ?", "profile_started");
  each("SELECT day, source, n FROM funnel_counts WHERE step = 'sent_plain' AND day BETWEEN ? AND ?", "sent_plain");
  // Соискатель появляется в базе вместе с первой сохранённой анкетой
  each(
    `SELECT ${DAY("s.created_at")} AS day, s.source, COUNT(*) AS n FROM seekers s
     WHERE EXISTS (SELECT 1 FROM profiles p WHERE p.seeker_id = s.id) AND ${DAY("s.created_at")} BETWEEN ? AND ?
     GROUP BY 1, 2`,
    "profile_done",
  );
  each(
    `SELECT ${DAY("a.sent_at")} AS day, s.source, COUNT(*) AS n FROM applications a JOIN seekers s ON s.id = a.seeker_id
     WHERE a.sent_at IS NOT NULL AND ${DAY("a.sent_at")} BETWEEN ? AND ? GROUP BY 1, 2`,
    "sent",
  );
  each(
    `SELECT ${DAY("a.sent_at")} AS day, s.source, COUNT(*) AS n FROM applications a JOIN seekers s ON s.id = a.seeker_id
     WHERE a.sent_at IS NOT NULL AND a.with_link = 1 AND ${DAY("a.sent_at")} BETWEEN ? AND ? GROUP BY 1, 2`,
    "sent_with_link",
  );
  // «Дошёл»: ссылку отклика, ушедшего со ссылкой на профиль, открыли. Один раз на отклик, в день первого
  // открытия; превью мессенджеров в views не попадают (page.ts), удалённые отклики не считаются
  each(
    `SELECT ${DAY("v.at")} AS day, s.source, COUNT(*) AS n
     FROM (SELECT application_id, seeker_id, MIN(at) AS at FROM views WHERE application_id IS NOT NULL GROUP BY application_id) v
     JOIN applications a ON a.id = v.application_id AND a.seeker_id = v.seeker_id AND a.with_link = 1
     JOIN seekers s ON s.id = v.seeker_id
     WHERE ${DAY("v.at")} BETWEEN ? AND ? GROUP BY 1, 2`,
    "reached",
  );
  // Работодатель ответил: пригласил или отказал. «Просмотрен» ответом не считается
  each(
    `SELECT ${DAY("e.at")} AS day, s.source, COUNT(*) AS n
     FROM (SELECT application_id, MIN(at) AS at FROM application_events WHERE by = 'employer' AND stage != 'seen' GROUP BY application_id) e
     JOIN applications a ON a.id = e.application_id JOIN seekers s ON s.id = a.seeker_id
     WHERE ${DAY("e.at")} BETWEEN ? AND ? GROUP BY 1, 2`,
    "answered",
  );
  return [...rows.values()].sort((a, b) => (a.day === b.day ? a.source.localeCompare(b.source) : a.day < b.day ? 1 : -1));
}

/** Сумма за весь период: строка на источник и общая. */
export function totals(rows: FunnelRow[]): { sources: FunnelRow[]; total: FunnelRow } {
  const total = blank("", "Всего");
  const bySource = new Map<string, FunnelRow>();
  for (const r of rows) {
    let s = bySource.get(r.source);
    if (!s) bySource.set(r.source, (s = blank("", r.source)));
    for (const f of NUMBERS) {
      s[f] += r[f];
      total[f] += r[f];
    }
  }
  return { sources: [...bySource.values()].sort((a, b) => b.opened - a.opened || a.source.localeCompare(b.source)), total };
}

export function funnelRoutes(ctx: Ctx): Route[] {
  // Один человек — одно событие шага в день. Только в памяти: до согласия о человеке ничего не пишем на диск
  let seenDay = "";
  let seen = new Set<string>();
  const first = (userId: number, step: Step, now: number) => {
    const day = localDay(now);
    if (day !== seenDay) {
      seenDay = day;
      seen = new Set();
    }
    const key = `${userId}:${step}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const admin = (req: Request) => {
    const key = ctx.config.crmKey;
    if (!key) throw new HttpError(503, "Админка не настроена: нет секрета ADMIN_PASSWORD");
    const given = Buffer.from((req.header("authorization") ?? "").replace(/^Bearer /, ""));
    const want = Buffer.from(key);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw new HttpError(403, "Неверный пароль админки");
  };

  return [
    // Приложение сообщает шаг и метку источника. Шаг считается обезличенно; метка привязывается
    // к соискателю, только если он уже дал согласие и метки у него ещё нет
    route("POST", "api", "/me/events", async (req) => {
      const { user } = ctx.auth(req);
      const body = (await req.json<Record<string, unknown>>()) ?? {};
      const step = body.step;
      if (step !== undefined && !(STEPS as readonly unknown[]).includes(step)) {
        throw new HttpError(400, "Поле step: open, profile_start или sent_plain");
      }
      const source = sourceOf(body.source);
      const now = ctx.now();
      if (step !== undefined && first(user.id, step as Step, now)) countStep(ctx.db, step as Step, source, now);
      if (getSeeker(ctx.db, user.id)) attachSource(ctx.db, user.id, source, now);
      return { status: 204 };
    }),

    route("GET", "api", "/admin/funnel", (req) => {
      admin(req);
      const asked = Number(req.query.get("days") ?? 30);
      const days = Number.isSafeInteger(asked) && asked >= 1 && asked <= 90 ? asked : 30;
      const now = ctx.now();
      const rows = funnel(ctx.db, localDay(now - (days - 1) * DAY_MS), localDay(now));
      return { headers: { "Cache-Control": "no-store" }, json: { days, rows, ...totals(rows) } };
    }),
  ];
}

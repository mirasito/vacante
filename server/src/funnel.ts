// Воронка перезапуска: открыл приложение → начал анкету → создал профиль → отправил отклик →
// работодатель открыл ссылку → работодатель ответил, по дням и по метке источника из ссылки запуска.
//
// До согласия о человеке ничего не хранится, поэтому первые два шага — обезличенные счётчики
// (funnel_counts), а повторы за день отсекаются в памяти процесса и на диск не попадают.
//
// Итог за период. Сложить дневные открытия нельзя: человек, открывавший приложение три дня, попал бы
// в итог трижды. Узнать его на сервере тоже нельзя: до согласия он для сервера никто. Поэтому «я уже
// открывал» помнит само устройство и присылает одно число — сколько дней назад (funnel_returns).
// Открытие, чьё прошлое открытие попало в тот же период, в итог не идёт; остаются люди.
//
// Шаги полной анкеты (funnel_form): дошёл до экрана и прошёл его, теми же обезличенными числами за день.
import { timingSafeEqual } from "node:crypto";

import type { Ctx } from "./app.ts";
import type { Db } from "./db.ts";
import { HttpError, route, type Request, type Route } from "./http.ts";
import { contactClicks } from "./go.ts";
import { postClicks } from "./page.ts";
import { getSeeker, iso } from "./seekers.ts";
import { DAY_MS, localDay } from "./time.ts";

export const STEPS = ["open", "profile_start", "sent_plain"] as const;
export type Step = (typeof STEPS)[number];

/** Экраны полной анкеты по порядку, как в приложении (app/src/profile/Wizard.tsx). */
export const FORM_SCREENS = ["consent", "place", "phone", "roles", "experience", "employment", "pay", "home", "start"] as const;
export type FormScreen = (typeof FORM_SCREENS)[number];
export const FORM_STEPS = ["form_reach", "form_pass"] as const;
export type FormStep = (typeof FORM_STEPS)[number];

/** Дальше период в админке не смотрит, поэтому давность больше не хранится. */
const MAX_GAP = 90;
/** Сколько дней назад было прошлое открытие на этом устройстве: 1…90 или null (первое, давнее, не по формату). */
export const gapOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_GAP ? value : null;

const SOURCE_RE = /^[a-z0-9]{1,8}$/;
/** Метка источника из приложения или null, если её нет или она не по формату ссылки запуска. */
export const sourceOf = (value: unknown): string | null => (typeof value === "string" && SOURCE_RE.test(value) ? value : null);

export function countStep(db: Db, step: Step, source: string | null, now: number): void {
  db.prepare(
    `INSERT INTO funnel_counts (day, source, step, n) VALUES (?, ?, ?, 1)
     ON CONFLICT (day, source, step) DO UPDATE SET n = n + 1`,
  ).run(localDay(now), source ?? "", step);
}

/** Открытие человека, который уже открывал приложение gap дней назад. */
export function countReturn(db: Db, source: string | null, gap: number, now: number): void {
  db.prepare(
    `INSERT INTO funnel_returns (day, source, gap, n) VALUES (?, ?, ?, 1)
     ON CONFLICT (day, source, gap) DO UPDATE SET n = n + 1`,
  ).run(localDay(now), source ?? "", gap);
}

/** Экран полной анкеты: человек дошёл до него (form_reach) или прошёл его (form_pass). */
export function countForm(db: Db, step: FormStep, screen: FormScreen, source: string | null, now: number): void {
  const column = step === "form_reach" ? "reached" : "passed";
  db.prepare(
    `INSERT INTO funnel_form (day, source, screen, ${column}) VALUES (?, ?, ?, 1)
     ON CONFLICT (day, source, screen) DO UPDATE SET ${column} = ${column} + 1`,
  ).run(localDay(now), source ?? "", screen);
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

/** Итог за период: opened — люди, открывшие приложение за период, opened_daily — сумма открытий по дням. */
export interface FunnelTotal extends FunnelRow {
  opened_daily: number;
}

/**
 * Сколько открытий за дни from…to сделали те, кто уже открывал приложение в этом же периоде, по источникам.
 * Открытие в день d с давностью gap повторное для периода, если прошлое было не раньше from: gap ≤ d − from.
 */
export function returning(db: Db, from: string, to: string): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT source, SUM(n) AS n FROM funnel_returns
       WHERE day BETWEEN ? AND ? AND gap <= CAST(julianday(day) - julianday(?) AS INTEGER) GROUP BY source`,
    )
    .all(from, to, from) as unknown as { source: string; n: number }[];
  return new Map(rows.map((r) => [r.source || NO_SOURCE, Number(r.n)]));
}

/**
 * Итог за весь период: строка на источник и общая. Шаги складываются по дням, кроме открытий: из них
 * вычитаются повторные (returns, см. returning), чтобы человек за период считался один раз.
 * Общий итог точен. В строке источника возможна погрешность, если человек вернулся с другой меткой:
 * первое открытие было без метки, а следующее пришло уже с меткой из ссылки.
 */
export function totals(rows: FunnelRow[], returns = new Map<string, number>()): { sources: FunnelTotal[]; total: FunnelTotal } {
  const total: FunnelTotal = { ...blank("", "Всего"), opened_daily: 0 };
  const bySource = new Map<string, FunnelTotal>();
  for (const r of rows) {
    let s = bySource.get(r.source);
    if (!s) bySource.set(r.source, (s = { ...blank("", r.source), opened_daily: 0 }));
    for (const f of NUMBERS) {
      s[f] += r[f];
      total[f] += r[f];
    }
  }
  total.opened_daily = total.opened;
  let back = 0;
  for (const s of bySource.values()) {
    s.opened_daily = s.opened;
    s.opened = Math.max(0, s.opened - (returns.get(s.source) ?? 0));
  }
  for (const n of returns.values()) back += n;
  total.opened = Math.max(0, total.opened - back);
  return { sources: [...bySource.values()].sort((a, b) => b.opened - a.opened || a.source.localeCompare(b.source)), total };
}

/** С какого дня приложение сообщает о повторных открытиях: за дни до него итог открытий завышен, как раньше. */
export function returnsSince(db: Db): string | null {
  return (db.prepare("SELECT MIN(day) AS day FROM funnel_returns").get() as { day: string | null }).day;
}

export interface FormRow {
  screen: FormScreen;
  reached: number;
  passed: number;
}

/** Полная анкета за дни from…to: строка на экран по порядку анкеты, все источники вместе. */
export function formSteps(db: Db, from: string, to: string): FormRow[] {
  const rows = db
    .prepare("SELECT screen, SUM(reached) AS reached, SUM(passed) AS passed FROM funnel_form WHERE day BETWEEN ? AND ? GROUP BY screen")
    .all(from, to) as unknown as FormRow[];
  const by = new Map(rows.map((r) => [r.screen as string, r]));
  return FORM_SCREENS.map((screen) => ({ screen, reached: Number(by.get(screen)?.reached ?? 0), passed: Number(by.get(screen)?.passed ?? 0) }));
}

export function funnelRoutes(ctx: Ctx): Route[] {
  // Один человек — одно событие шага в день. Только в памяти: до согласия о человеке ничего не пишем на диск
  let seenDay = "";
  let seen = new Set<string>();
  const first = (userId: number, step: string, now: number) => {
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
      const form = (FORM_STEPS as readonly unknown[]).includes(step);
      if (step !== undefined && !form && !(STEPS as readonly unknown[]).includes(step)) {
        throw new HttpError(400, "Поле step: open, profile_start, sent_plain, form_reach или form_pass");
      }
      if (form && !(FORM_SCREENS as readonly unknown[]).includes(body.screen)) {
        throw new HttpError(400, `Поле screen: ${FORM_SCREENS.join(", ")}`);
      }
      const source = sourceOf(body.source);
      const now = ctx.now();
      if (form) {
        // Экран анкеты: человек мог вернуться назад и прийти снова, за день считаем один раз
        if (first(user.id, `${step}:${body.screen}`, now)) countForm(ctx.db, step as FormStep, body.screen as FormScreen, source, now);
      } else if (step !== undefined && first(user.id, step as Step, now)) {
        countStep(ctx.db, step as Step, source, now);
        // Повторное открытие считается вместе с самим открытием: без него вычитать не из чего
        const gap = step === "open" ? gapOf(body.gap) : null;
        if (gap !== null) countReturn(ctx.db, source, gap, now);
      }
      if (getSeeker(ctx.db, user.id)) attachSource(ctx.db, user.id, source, now);
      return { status: 204 };
    }),

    route("GET", "api", "/admin/funnel", (req) => {
      admin(req);
      const asked = Number(req.query.get("days") ?? 30);
      const days = Number.isSafeInteger(asked) && asked >= 1 && asked <= 90 ? asked : 30;
      const now = ctx.now();
      const from = localDay(now - (days - 1) * DAY_MS);
      const to = localDay(now);
      const rows = funnel(ctx.db, from, to);
      // sources и total — итог за период: opened в них — люди (повторные открытия вычтены), opened_daily —
      // сумма по дням; returns_since — с какого дня есть данные о повторных. form — экраны полной анкеты.
      // clicks — нажатия на прямые кнопки связи «WhatsApp», «Позвонить», «Telegram» (go.ts) и на кнопку
      // «разместить вакансию» на странице профиля (page.ts, источник page, вид post)
      return {
        headers: { "Cache-Control": "no-store" },
        json: {
          days,
          rows,
          ...totals(rows, returning(ctx.db, from, to)),
          returns_since: returnsSince(ctx.db),
          form: formSteps(ctx.db, from, to),
          clicks: [...contactClicks(ctx.db, from, to), ...postClicks(ctx.db, from, to)],
        },
      };
    }),
  ];
}

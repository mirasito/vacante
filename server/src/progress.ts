// Цель недели и достижения. Награда только за настоящие шаги к работе: цель считает отправленные
// отклики, а каждое достижение совпадает с событием в отклике или профиле. Серия недель прощает
// один пропуск в месяц. Рейтинга по числу откликов нет: он поощрял бы спам работодателям.
import { tx, type Db } from "./db.ts";
import { HttpError } from "./http.ts";
import { iso } from "./seekers.ts";
import { dayStartOf, isValidDay, localDay, weekStart } from "./time.ts";

export const GOALS = [3, 5, 10] as const;
export type Goal = (typeof GOALS)[number];
const WEEK_MS = 7 * 86_400_000;
/** Сколько недель назад смотрит серия. */
const HORIZON = 52;
/** Пропуск прощается, если прежний прощённый был не ближе чем столько недель назад: один в месяц. */
const PASS_EVERY = 4;

export const ACHIEVEMENTS = ["video", "first_sent", "first_invite", "first_interview", "hired"] as const;
export type Achievement = (typeof ACHIEVEMENTS)[number];

export interface WeekResult {
  /** 0 — цели не было. */
  goal: number;
  sent: number;
}

/**
 * Серия недель с выполненной целью, по неделям от старых к идущей (она последняя). Идущая неделя
 * прибавляет к серии, когда цель уже выполнена, и ничего не обрывает: она ещё не кончилась. Неделя без
 * цели обрывает серию. Невыполненная неделя прощается, если в 3 соседние недели прощённых не было.
 * forgiven — прощена прошлая неделя, а серия была и до неё: это стоит показать.
 */
export function streakOf(weeks: WeekResult[]): { streak: number; forgiven: boolean } {
  const current = weeks.length - 1;
  let streak = 0;
  let pass: number | null = null;
  // Серия к моменту, когда простили прошлую неделю: если после неё ничего не набралось, прощать было нечего
  let atLastWeek: number | null = null;
  for (let i = current; i >= 0; i--) {
    const w = weeks[i]!;
    if (!w.goal) break;
    if (w.sent >= w.goal) streak++;
    else if (i === current) continue;
    else if (pass === null || pass - i >= PASS_EVERY) {
      pass = i;
      if (i === current - 1) atLastWeek = streak;
    } else break;
  }
  return { streak, forgiven: atLastWeek !== null && streak > atLastWeek };
}

export interface GoalView {
  /** Цель на эту неделю; null — цели нет. */
  goal: Goal | null;
  /** Сколько откликов отправлено на этой неделе. */
  sent: number;
  /** Недель подряд с выполненной целью, вместе с этой, если она уже выполнена. */
  streak: number;
  /** Прошлую неделю не выполнили, но серия сохранилась. */
  forgiven: boolean;
  /** Прошлая неделя: для итога недели в боте. null — цели тогда ещё не было. */
  last: WeekResult | null;
}

/** Понедельник недели, ГГГГ-ММ-ДД по времени Казахстана. */
const weekKey = (ms: number) => localDay(weekStart(ms));

function sentByWeek(db: Db, seekerId: number, from: number): Map<string, number> {
  const rows = db
    .prepare("SELECT sent_at FROM applications WHERE seeker_id = ? AND sent_at >= ?")
    .all(seekerId, iso(from)) as { sent_at: string }[];
  const out = new Map<string, number>();
  for (const r of rows) {
    const key = weekKey(Date.parse(r.sent_at));
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/**
 * Цель и серия на сейчас. Закончившиеся недели заодно записываются, и дальше их итог не меняется.
 * Транзакцию не открывает, поэтому её можно звать откуда угодно.
 */
export function goalView(db: Db, seekerId: number, now: number): GoalView {
  const thisWeek = weekStart(now);
  const rows = db
    .prepare("SELECT week, goal, sent FROM goal_weeks WHERE seeker_id = ? ORDER BY week")
    .all(seekerId) as { week: string; goal: number; sent: number | null }[];
  if (!rows.length) {
    return { goal: null, sent: sentByWeek(db, seekerId, thisWeek).get(weekKey(now)) ?? 0, streak: 0, forgiven: false, last: null };
  }
  const start = Math.max(dayStartOf(rows[0]!.week), thisWeek - HORIZON * WEEK_MS);
  const counts = sentByWeek(db, seekerId, start);
  const byWeek = new Map(rows.map((r) => [r.week, r]));
  // У недели без своей строки та же цель, что у последней недели до неё
  let goal = 0;
  for (const r of rows) if (dayStartOf(r.week) <= start) goal = r.goal;
  const freeze = db.prepare(
    `INSERT INTO goal_weeks (seeker_id, week, goal, sent) VALUES (?, ?, ?, ?)
     ON CONFLICT (seeker_id, week) DO UPDATE SET sent = excluded.sent WHERE goal_weeks.sent IS NULL`,
  );
  const weeks: WeekResult[] = [];
  for (let w = start; w <= thisWeek; w += WEEK_MS) {
    const key = localDay(w);
    const row = byWeek.get(key);
    if (row) goal = row.goal;
    const live = counts.get(key) ?? 0;
    const past = w < thisWeek;
    if (past && goal && row?.sent == null) freeze.run(seekerId, key, goal, live);
    weeks.push({ goal, sent: past ? (row?.sent ?? live) : live });
  }
  const { streak, forgiven } = streakOf(weeks);
  const current = weeks[weeks.length - 1]!;
  return {
    goal: current.goal ? (current.goal as Goal) : null,
    sent: current.sent,
    streak,
    forgiven,
    last: weeks.length > 1 ? weeks[weeks.length - 2]! : null,
  };
}

export function parseGoal(body: unknown): Goal | null {
  const goal = (body as { goal?: unknown } | null)?.goal;
  if (goal === null) return null;
  if (!(GOALS as readonly unknown[]).includes(goal)) throw new HttpError(400, "Поле goal: 3, 5, 10 или null");
  return goal as Goal;
}

/** Цель начиная с этой недели. null выключает её: серия обрывается. */
export function setGoal(db: Db, seekerId: number, goal: Goal | null, now: number): void {
  db.prepare(
    `INSERT INTO goal_weeks (seeker_id, week, goal) VALUES (?, ?, ?)
     ON CONFLICT (seeker_id, week) DO UPDATE SET goal = excluded.goal`,
  ).run(seekerId, weekKey(now), goal ?? 0);
}

/**
 * Цель, заведённая на телефоне до профиля, вместе с прошлыми неделями: так серия не теряется.
 * Ложится только на профиль, где цели ещё не было, иначе ничего не меняет: цель на сервере главнее.
 * Звать после переноса откликов: закончившиеся недели считаются по ним при первой же сводке.
 */
export function importGoal(db: Db, seekerId: number, body: unknown, now: number): void {
  const goal = parseGoal(body);
  const raw = (body as { history?: unknown }).history;
  const thisWeek = weekKey(now);
  const oldest = weekKey(now - HORIZON * WEEK_MS);
  const history = (Array.isArray(raw) ? raw.slice(-60) : []).flatMap((h) => {
    const { week, goal } = (h ?? {}) as { week?: unknown; goal?: unknown };
    if (typeof week !== "string" || !isValidDay(week) || weekKey(dayStartOf(week)) !== week) return [];
    if (week >= thisWeek || week < oldest) return [];
    if (goal !== 0 && !(GOALS as readonly unknown[]).includes(goal)) return [];
    return [{ week, goal: goal as number }];
  });
  tx(db, () => {
    if (db.prepare("SELECT 1 FROM goal_weeks WHERE seeker_id = ? LIMIT 1").get(seekerId)) return;
    const insert = db.prepare("INSERT OR IGNORE INTO goal_weeks (seeker_id, week, goal) VALUES (?, ?, ?)");
    for (const h of history) insert.run(seekerId, h.week, h.goal);
    setGoal(db, seekerId, goal, now);
  });
}

export interface AchievementView {
  kind: Achievement;
  at: string;
  /** Приложение уже поздравило. */
  seen: boolean;
}

/** Когда сделан шаг: время события в профиле или отклике, null — ещё не сделан. */
function earnedAt(db: Db, seekerId: number, kind: Achievement, now: number): string | null {
  const at = (sql: string, ...args: (string | number)[]) =>
    (db.prepare(sql).get(...args) as { at: string | null } | undefined)?.at ?? null;
  const events = (stages: string) =>
    at(
      `SELECT MIN(e.at) AS at FROM application_events e JOIN applications a ON a.id = e.application_id
       WHERE a.seeker_id = ? AND e.stage IN (${stages})`,
      seekerId,
    );
  switch (kind) {
    case "video":
      return at("SELECT recorded_at AS at FROM videos WHERE seeker_id = ? AND file IS NOT NULL", seekerId);
    case "first_sent":
      return at("SELECT MIN(sent_at) AS at FROM applications WHERE seeker_id = ?", seekerId);
    case "first_invite":
      return events("'invited', 'interview', 'offer', 'hired'");
    case "first_interview":
      // Время собеседования прошло, а отклик тогда был жив: стадия всё ещё «Собеседование» или дальше,
      // или исход пришёл уже после собеседования. Предложение работы без даты тоже значит собеседование
      return at(
        `SELECT MIN(at) AS at FROM (
           SELECT a.interview_at AS at FROM applications a
           WHERE a.seeker_id = ? AND a.interview_at <= ? AND (a.stage IN ('interview', 'offer', 'hired') OR EXISTS (
             SELECT 1 FROM application_events e WHERE e.application_id = a.id AND e.at >= a.interview_at
               AND e.stage IN ('offer', 'hired', 'rejected', 'no_answer', 'not_interested')))
           UNION ALL
           SELECT e.at FROM application_events e JOIN applications a ON a.id = e.application_id
           WHERE a.seeker_id = ? AND a.interview_at IS NULL AND e.stage IN ('offer', 'hired'))`,
        seekerId,
        iso(now),
        seekerId,
      );
    case "hired":
      return events("'hired'");
  }
}

/** Достижения человека: новые записываются сразу, как только шаг сделан. */
export function achievements(db: Db, seekerId: number, now: number): AchievementView[] {
  const list = () =>
    (
      db.prepare("SELECT kind, at, seen FROM achievements WHERE seeker_id = ? ORDER BY at, kind").all(seekerId) as {
        kind: Achievement;
        at: string;
        seen: number;
      }[]
    ).map((r) => ({ kind: r.kind, at: r.at, seen: r.seen === 1 }));
  const have = list();
  if (have.length === ACHIEVEMENTS.length) return have;
  const known = new Set(have.map((a) => a.kind));
  const insert = db.prepare("INSERT OR IGNORE INTO achievements (seeker_id, kind, at) VALUES (?, ?, ?)");
  let added = false;
  for (const kind of ACHIEVEMENTS) {
    if (known.has(kind)) continue;
    const at = earnedAt(db, seekerId, kind, now);
    if (at) {
      insert.run(seekerId, kind, at);
      added = true;
    }
  }
  return added ? list() : have;
}

/** Приложение показало поздравление. */
export function achievementsSeen(db: Db, seekerId: number): void {
  db.prepare("UPDATE achievements SET seen = 1 WHERE seeker_id = ? AND seen = 0").run(seekerId);
}

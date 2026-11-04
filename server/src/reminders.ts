// Напоминания соискателю: вкладка «Напоминания» в приложении, раздел в профиле и сообщения в боте.
// Системные напоминания сервер сам выводит из откликов и профиля (planReminders), свои человек
// заводит сам. Что и когда уходит в бот, решает reminder-bot.ts.
import type { ApplicationRow, Stage } from "./applications.ts";
import { weekNumbers } from "./applications.ts";
import { tx, type Db } from "./db.ts";
import { HttpError } from "./http.ts";
import { iso } from "./seekers.ts";
import { DAY_MS, dayStartOf, localDay, localDayStart, localHour, weekStart } from "./time.ts";

export const KINDS = [
  "write_again",
  "status_check",
  "interview_eve",
  "interview_soon",
  "how_was_it",
  "start_eve",
  "profile",
  "week",
  "custom",
] as const;
export type Kind = (typeof KINDS)[number];

/** Группы, которые человек включает и выключает в профиле. Свои напоминания не выключаются. */
export const GROUPS = {
  applications: ["write_again", "status_check"],
  interviews: ["interview_eve", "interview_soon", "how_was_it"],
  start: ["start_eve"],
  profile: ["profile"],
  week: ["week"],
} as const satisfies Record<string, readonly Kind[]>;
export type Group = keyof typeof GROUPS;
export const GROUP_NAMES = Object.keys(GROUPS) as Group[];

export const groupOf = (kind: Kind): Group | null =>
  GROUP_NAMES.find((g) => (GROUPS[g] as readonly Kind[]).includes(kind)) ?? null;

export type Status = "waiting" | "sent" | "done" | "dismissed";

export interface ReminderRow {
  id: number;
  seeker_id: number;
  application_id: number | null;
  kind: Kind;
  key: string | null;
  text: string | null;
  due_at: string;
  expires_at: string | null;
  status: Status;
  closed_by: "seeker" | "system" | null;
  sent_at: string | null;
  message_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface Settings {
  /** Выключенные группы. */
  off: Group[];
  /** Присылать ли напоминания в чат бота. В приложении они видны всегда. */
  bot: boolean;
}

const HOUR = 3_600_000;
const MINUTE = 60_000;
/** Своих напоминаний, которые ещё не наступили, не больше. */
export const MAX_CUSTOM = 50;
export const MAX_TEXT = 120;
/** Окно бота: с 9:00 до 21:00 по Казахстану. Напоминание за два часа до собеседования — с 7:00. */
export const WINDOW = { from: 9, to: 21, interviewFrom: 7 };
/** В бот не больше двух напоминаний в день. */
export const PER_DAY = 2;

const ACTIVE: readonly Stage[] = ["liked", "sent", "seen", "invited", "interview", "offer"];

export function getSettings(db: Db, seekerId: number): Settings {
  const row = db.prepare("SELECT reminders_off, reminders_bot FROM seekers WHERE id = ?").get(seekerId) as
    | { reminders_off: string; reminders_bot: number }
    | undefined;
  if (!row) return { off: [], bot: true };
  let off: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(row.reminders_off);
    if (Array.isArray(parsed)) off = parsed;
  } catch {
    off = [];
  }
  return { off: GROUP_NAMES.filter((g) => off.includes(g)), bot: row.reminders_bot === 1 };
}

export function parseSettings(body: unknown): Settings {
  const b = (body ?? {}) as { off?: unknown; bot?: unknown };
  if (!Array.isArray(b.off) || typeof b.bot !== "boolean") throw new HttpError(400, "Нужны off (список) и bot (да или нет)");
  const off: unknown[] = b.off;
  const unknown = off.filter((g) => !GROUP_NAMES.includes(g as Group));
  if (unknown.length) throw new HttpError(400, `Нет такой группы напоминаний: ${unknown.join(", ")}`);
  return { off: GROUP_NAMES.filter((g) => off.includes(g)), bot: b.bot };
}

export function saveSettings(db: Db, seekerId: number, s: Settings, now: number) {
  db.prepare("UPDATE seekers SET reminders_off = ?, reminders_bot = ? WHERE id = ?").run(JSON.stringify(s.off), s.bot ? 1 : 0, seekerId);
  planReminders(db, seekerId, now);
}

/** Одну группу выключить: кнопка «Не присылать такие» в боте. */
export function turnOff(db: Db, seekerId: number, group: Group, now: number) {
  const s = getSettings(db, seekerId);
  if (!s.off.includes(group)) saveSettings(db, seekerId, { ...s, off: [...s.off, group] }, now);
}

interface Wanted {
  key: string;
  kind: Kind;
  application_id: number | null;
  due: number;
  expires: number;
  /** Насколько позже срока напоминание ещё стоит завести: собеседование назначили в 20:30 на завтра. */
  late: number;
}

/** Какие системные напоминания должны быть у человека сейчас, по его откликам и профилю. */
function wanted(db: Db, seekerId: number, now: number): Wanted[] {
  const settings = getSettings(db, seekerId);
  const apps = db.prepare("SELECT * FROM applications WHERE seeker_id = ?").all(seekerId) as unknown as ApplicationRow[];
  const changed = new Map(
    (
      db
        .prepare(
          `SELECT e.application_id AS id, MAX(e.at) AS at FROM application_events e JOIN applications a ON a.id = e.application_id
           WHERE a.seeker_id = ? GROUP BY e.application_id`,
        )
        .all(seekerId) as { id: number; at: string }[]
    ).map((r) => [r.id, r.at]),
  );
  const out: Wanted[] = [];
  for (const a of apps) {
    // «Написать ещё раз»: два дня после отклика в WhatsApp или Telegram, а профиль не открывали
    if (a.stage === "sent" && a.sent_at && (a.method === "whatsapp" || a.method === "telegram")) {
      const sent = Date.parse(a.sent_at);
      out.push({ key: `write_again:${a.id}`, kind: "write_again", application_id: a.id, due: sent + 2 * DAY_MS, expires: sent + 6 * DAY_MS, late: DAY_MS });
    }
    // «Что с откликом?»: неделя без перемен
    if (a.stage === "sent" || a.stage === "seen") {
      const since = Date.parse(changed.get(a.id) ?? a.sent_at ?? a.updated_at);
      out.push({
        key: `status_check:${a.id}:${a.stage}`,
        kind: "status_check",
        application_id: a.id,
        due: since + 7 * DAY_MS,
        expires: since + 14 * DAY_MS,
        late: 7 * DAY_MS,
      });
    }
    // Собеседование: накануне в 19:00 и за два часа (не раньше 7:00), «Как прошло?» на следующий день
    if (a.stage === "interview" && a.interview_at) {
      const at = Date.parse(a.interview_at);
      const day = localDayStart(at);
      const anchor = `${a.id}:${a.interview_at}`;
      out.push({ key: `interview_eve:${anchor}`, kind: "interview_eve", application_id: a.id, due: day - DAY_MS + 19 * HOUR, expires: at - 2 * HOUR, late: 3 * HOUR });
      out.push({
        key: `interview_soon:${anchor}`,
        kind: "interview_soon",
        application_id: a.id,
        due: Math.max(at - 2 * HOUR, day + WINDOW.interviewFrom * HOUR),
        expires: at,
        late: 15 * MINUTE,
      });
      const how = Math.max(day + DAY_MS + 10 * HOUR, at + 3 * HOUR);
      out.push({ key: `how_was_it:${anchor}`, kind: "how_was_it", application_id: a.id, due: how, expires: how + 3 * DAY_MS, late: 3 * DAY_MS });
    }
    // Выход на работу: накануне вечером
    if ((a.stage === "offer" || a.stage === "hired") && a.start_at) {
      const day = dayStartOf(a.start_at);
      out.push({
        key: `start_eve:${a.id}:${a.start_at}`,
        kind: "start_eve",
        application_id: a.id,
        due: day - DAY_MS + 19 * HOUR,
        expires: day + 9 * HOUR,
        late: 3 * HOUR,
      });
    }
  }
  const seeker = db
    .prepare(
      `SELECT s.created_at,
         EXISTS (SELECT 1 FROM profiles p WHERE p.seeker_id = s.id) AS profile,
         EXISTS (SELECT 1 FROM videos v WHERE v.seeker_id = s.id AND v.file IS NOT NULL) AS video
       FROM seekers s WHERE s.id = ?`,
    )
    .get(seekerId) as { created_at: string; profile: number; video: number } | undefined;
  if (seeker) {
    const created = Date.parse(seeker.created_at);
    // Кружок: на следующий день после профиля, если его так и не записали
    if (seeker.profile && !seeker.video) {
      out.push({ key: "profile", kind: "profile", application_id: null, due: created + DAY_MS, expires: created + 4 * DAY_MS, late: 3 * DAY_MS });
    }
    // Итог недели: в понедельник в 10:00, если профиль появился раньше и на прошлой неделе что-то было
    const monday = weekStart(now);
    if (created < monday && now < monday + 21 * HOUR && apps.some((a) => ACTIVE.includes(a.stage))) {
      const last = weekNumbers(db, seekerId, iso(monday - 7 * DAY_MS), iso(monday));
      if (last.sent + last.seen + last.invited > 0) {
        out.push({ key: `week:${localDay(monday)}`, kind: "week", application_id: null, due: monday + 10 * HOUR, expires: monday + 21 * HOUR, late: 11 * HOUR });
      }
    }
  }
  return out.filter((w) => {
    const g = groupOf(w.kind);
    return !g || !settings.off.includes(g);
  });
}

/**
 * Сверяет системные напоминания с откликами и профилем: заводит новые, а те, что уже не нужны
 * (стадия сменилась, собеседование перенесли, группу выключили), отменяет. Свои не трогает.
 */
export function planReminders(db: Db, seekerId: number, now: number): void {
  const want = wanted(db, seekerId, now);
  const at = iso(now);
  tx(db, () => {
    const existing = db
      .prepare("SELECT id, key, status, closed_by FROM reminders WHERE seeker_id = ? AND key IS NOT NULL")
      .all(seekerId) as { id: number; key: string; status: Status; closed_by: string | null }[];
    const known = new Map(existing.map((r) => [r.key, r]));
    const keep = new Set(want.map((w) => w.key));
    const insert = db.prepare(
      `INSERT INTO reminders (seeker_id, application_id, kind, key, due_at, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const revive = db.prepare(
      "UPDATE reminders SET status = 'waiting', closed_by = NULL, due_at = ?, expires_at = ?, updated_at = ? WHERE id = ?",
    );
    for (const w of want) {
      if (now >= w.expires || now > w.due + w.late) continue;
      const r = known.get(w.key);
      if (!r) insert.run(seekerId, w.application_id, w.kind, w.key, iso(w.due), iso(w.expires), at, at);
      // Группу включили снова: отменённое системой возвращается, пока оно не опоздало
      else if (r.status === "dismissed" && r.closed_by === "system") revive.run(iso(w.due), iso(w.expires), at, r.id);
    }
    const close = db.prepare("UPDATE reminders SET status = ?, closed_by = 'system', updated_at = ? WHERE id = ?");
    for (const r of existing) {
      if (keep.has(r.key)) continue;
      // Не отправленное отменяем, а отправленное считаем сделанным: человек уже поменял стадию сам
      if (r.status === "waiting") close.run("dismissed", at, r.id);
      else if (r.status === "sent") close.run("done", at, r.id);
    }
  });
}

/** Сверить всех, у кого есть профиль: планировщик делает это перед каждой отправкой. */
export function planAll(db: Db, now: number): void {
  const ids = db.prepare("SELECT seeker_id FROM profiles").all() as { seeker_id: number }[];
  for (const { seeker_id } of ids) planReminders(db, seeker_id, now);
}

/** Не отправленное вовремя и уже ненужное (собеседование прошло) больше не отправляем. */
export function expire(db: Db, now: number, seekerId?: number): void {
  const at = iso(now);
  if (seekerId === undefined) {
    db.prepare(
      "UPDATE reminders SET status = 'dismissed', closed_by = 'system', updated_at = ? WHERE status = 'waiting' AND expires_at <= ?",
    ).run(at, at);
  } else {
    db.prepare(
      `UPDATE reminders SET status = 'dismissed', closed_by = 'system', updated_at = ?
       WHERE seeker_id = ? AND status = 'waiting' AND expires_at <= ?`,
    ).run(at, seekerId, at);
  }
}

export function getReminder(db: Db, seekerId: number, id: number): ReminderRow | undefined {
  return db.prepare("SELECT * FROM reminders WHERE id = ? AND seeker_id = ?").get(id, seekerId) as ReminderRow | undefined;
}

/** Ещё ждёт действия: не сделано, не убрано и не просрочено. */
export const isActive = (r: Pick<ReminderRow, "status" | "expires_at">, now: number) =>
  (r.status === "waiting" || r.status === "sent") && (!r.expires_at || Date.parse(r.expires_at) > now);

/** Своё напоминание: текст и время из приложения. */
export function parseCustom(body: unknown, now: number): { text: string; at: number } {
  const b = (body ?? {}) as { text?: unknown; at?: unknown };
  const text = typeof b.text === "string" ? b.text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!text) throw new HttpError(400, "Напишите, о чём напомнить");
  const at = typeof b.at === "string" ? Date.parse(b.at) : NaN;
  if (!Number.isFinite(at) || at < now - 5 * MINUTE || at > now + 183 * DAY_MS) {
    throw new HttpError(400, "Время напоминания: от сейчас и до полугода вперёд");
  }
  return { text: text.slice(0, MAX_TEXT), at };
}

export function addCustom(db: Db, seekerId: number, c: { text: string; at: number }, now: number): number {
  const waiting = Number(
    (
      db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE seeker_id = ? AND kind = 'custom' AND status IN ('waiting', 'sent')").get(seekerId) as {
        n: number;
      }
    ).n,
  );
  if (waiting >= MAX_CUSTOM) throw new HttpError(409, `Своих напоминаний может быть не больше ${MAX_CUSTOM}`);
  const at = iso(now);
  const r = db
    .prepare(
      `INSERT INTO reminders (seeker_id, kind, text, due_at, created_at, updated_at) VALUES (?, 'custom', ?, ?, ?, ?) RETURNING id`,
    )
    .get(seekerId, c.text, iso(c.at), at, at) as { id: number };
  return r.id;
}

export type Action = { kind: "done" } | { kind: "dismiss" } | { kind: "snooze"; until: number };

/** «Отложить»: на час, но не позже 21:00 и не раньше 9:00 по Казахстану. */
export function snoozeTime(now: number): number {
  const t = now + HOUR;
  const h = localHour(t);
  if (h >= WINDOW.to) return localDayStart(t) + DAY_MS + WINDOW.from * HOUR;
  if (h < WINDOW.from) return localDayStart(t) + WINDOW.from * HOUR;
  return t;
}

export function parseAction(body: unknown, now: number): Action {
  const b = (body ?? {}) as { action?: unknown; until?: unknown };
  if (b.action === "done" || b.action === "dismiss") return { kind: b.action };
  if (b.action === "snooze") {
    if (b.until === undefined) return { kind: "snooze", until: snoozeTime(now) };
    const until = typeof b.until === "string" ? Date.parse(b.until) : NaN;
    if (!Number.isFinite(until) || until <= now || until > now + 183 * DAY_MS) throw new HttpError(400, "Отложить можно на время в будущем");
    return { kind: "snooze", until };
  }
  throw new HttpError(400, "Действие: done, dismiss или snooze");
}

/** «Готово», «Убрать» или «Отложить». false, если напоминания нет или оно уже закрыто. */
export function actOn(db: Db, seekerId: number, id: number, action: Action, now: number): boolean {
  const r = getReminder(db, seekerId, id);
  if (!r || r.status === "done" || r.status === "dismissed") return false;
  const at = iso(now);
  if (action.kind === "snooze") {
    // Отложенное напоминание не пропадёт раньше, чем наступит новое время
    const expires = r.expires_at && Date.parse(r.expires_at) < action.until + HOUR ? iso(action.until + HOUR) : r.expires_at;
    db.prepare("UPDATE reminders SET status = 'waiting', due_at = ?, expires_at = ?, updated_at = ? WHERE id = ?").run(
      iso(action.until),
      expires,
      at,
      id,
    );
  } else {
    db.prepare("UPDATE reminders SET status = ?, closed_by = 'seeker', updated_at = ? WHERE id = ?").run(
      action.kind === "done" ? "done" : "dismissed",
      at,
      id,
    );
  }
  return true;
}

export interface ReminderView {
  id: number;
  kind: Kind;
  text: string | null;
  due_at: string;
  expires_at: string | null;
  status: Status;
  closed_by: "seeker" | "system" | null;
  sent_at: string | null;
  /** Ещё ждёт действия. */
  active: boolean;
  application: Pick<
    ApplicationRow,
    "id" | "vacancy_id" | "title" | "title_kk" | "employer" | "city" | "address" | "map" | "url" | "source_url" | "method" | "stage" | "interview_at" | "start_at"
  > & { contact: string[] } | null;
  /** У итога недели: цифры прошлой недели. */
  week?: { sent: number; seen: number; invited: number };
}

function toView(db: Db, r: ReminderRow, apps: Map<number, ApplicationRow>, now: number): ReminderView {
  const a = r.application_id ? apps.get(r.application_id) : undefined;
  let contact: string[] = [];
  try {
    contact = a ? (JSON.parse(a.contact) as string[]) : [];
  } catch {
    contact = [];
  }
  const view: ReminderView = {
    id: r.id,
    kind: r.kind,
    text: r.text,
    due_at: r.due_at,
    expires_at: r.expires_at,
    status: r.status,
    closed_by: r.closed_by,
    sent_at: r.sent_at,
    active: isActive(r, now),
    application: a
      ? {
          id: a.id,
          vacancy_id: a.vacancy_id,
          title: a.title,
          title_kk: a.title_kk,
          employer: a.employer,
          city: a.city,
          address: a.address,
          map: a.map,
          url: a.url,
          source_url: a.source_url,
          method: a.method,
          stage: a.stage,
          interview_at: a.interview_at,
          start_at: a.start_at,
          contact,
        }
      : null,
  };
  if (r.kind === "week") {
    const monday = weekStart(Date.parse(r.due_at));
    view.week = weekNumbers(db, r.seeker_id, iso(monday - 7 * DAY_MS), iso(monday));
  }
  return view;
}

/**
 * Для вкладки: всё, что ещё ждёт (по времени), и история за 30 дней: сделанное, убранное
 * и прошедшее. Отменённое системой (стадия сменилась раньше срока) в историю не идёт.
 */
export function listReminders(db: Db, seekerId: number, now: number): { reminders: ReminderView[]; due: number } {
  expire(db, now, seekerId);
  const rows = db
    .prepare(
      `SELECT * FROM reminders WHERE seeker_id = ? AND (
         (status IN ('waiting', 'sent') AND (expires_at IS NULL OR expires_at > ?))
         OR (updated_at >= ? AND NOT (status = 'dismissed' AND closed_by = 'system'))
       ) ORDER BY due_at`,
    )
    .all(seekerId, iso(now), iso(now - 30 * DAY_MS)) as unknown as ReminderRow[];
  const apps = new Map(
    (db.prepare("SELECT * FROM applications WHERE seeker_id = ?").all(seekerId) as unknown as ApplicationRow[]).map((a) => [a.id, a]),
  );
  const views = rows.map((r) => toView(db, r, apps, now));
  const active = views.filter((v) => v.active);
  const history = views
    .filter((v) => !v.active)
    .sort((a, b) => (a.due_at < b.due_at ? 1 : -1))
    .slice(0, 100);
  // Счётчик на вкладке: что пора сделать сегодня, включая прошедшее
  const endOfToday = localDayStart(now) + DAY_MS;
  const due = active.filter((v) => Date.parse(v.due_at) < endOfToday).length;
  return { reminders: [...active, ...history], due };
}

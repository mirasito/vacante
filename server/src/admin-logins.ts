// Журнал попыток входа в админку и блокировка подбора пароля.
//
// Пишем каждую попытку с неверным паролем и первую верную с адреса и браузера за шесть часов
// (админка ходит на сервер десятки раз за сессию, каждую верную писать незачем). После
// MAX_WRONG неверных попыток за окно адрес получает 429 и пароль с него не проверяется до конца окна.
// Записи старше 30 дней удаляются. Журнал виден в админке (GET /admin/logins) и в workflow «Статистика».
import type { Db } from "./db.ts";
import type { Request } from "./http.ts";
import { RateLimit } from "./limits.ts";
import { iso } from "./seekers.ts";

export const MAX_WRONG = 10;
export const WINDOW_MS = 15 * 60_000;
const OK_EVERY_MS = 6 * 60 * 60_000;
/** Больше стольких записей с одного адреса за окно не пишем, чтобы подбор не раздувал базу. */
const LOG_PER_WINDOW = 30;
const KEEP_DAYS = 30;

export type Result = "ok" | "wrong" | "blocked";

interface State {
  wrong: RateLimit;
  logged: RateLimit;
  okAt: Map<string, number>;
  cleanedAt: number;
}
const states = new WeakMap<Db, State>();
const stateOf = (db: Db): State => {
  let s = states.get(db);
  if (!s) {
    s = { wrong: new RateLimit(MAX_WRONG - 1, WINDOW_MS), logged: new RateLimit(LOG_PER_WINDOW, WINDOW_MS), okAt: new Map(), cleanedAt: 0 };
    states.set(db, s);
  }
  return s;
};

export const clientIp = (req: Request) => (req.header("x-forwarded-for") ?? "").split(",")[0]?.trim() || "local";

/** Адрес уже сделал MAX_WRONG неверных попыток в этом окне: пароль не проверяем (лимит счётчика MAX_WRONG - 1). */
export function isBlocked(db: Db, ip: string, now: number): boolean {
  return !stateOf(db).wrong.take(ip, now, 0);
}

export function recordLogin(db: Db, req: Request, result: Result, now: number): void {
  const s = stateOf(db);
  const ip = clientIp(req);
  const ua = (req.header("user-agent") ?? "").slice(0, 200);
  if (result === "wrong") s.wrong.take(ip, now);
  if (result === "ok") {
    const key = `${ip} ${ua}`;
    const last = s.okAt.get(key);
    if (last !== undefined && now - last < OK_EVERY_MS) return;
    if (s.okAt.size > 1000) s.okAt.clear();
    s.okAt.set(key, now);
  } else if (!s.logged.take(ip, now)) {
    return;
  }
  db.prepare("INSERT INTO admin_logins (at, result, ip, ua, path) VALUES (?, ?, ?, ?, ?)").run(
    iso(now), result, ip, ua, req.path.slice(0, 200),
  );
  if (now - s.cleanedAt > 60 * 60_000) {
    s.cleanedAt = now;
    db.prepare("DELETE FROM admin_logins WHERE at < ?").run(iso(now - KEEP_DAYS * 24 * 60 * 60_000));
  }
}

export interface LoginRow {
  at: string;
  result: Result;
  ip: string;
  ua: string;
  path: string;
}

/** Последние записи журнала, новые сверху. */
export function recentLogins(db: Db, limit = 200): LoginRow[] {
  return db.prepare("SELECT at, result, ip, ua, path FROM admin_logins ORDER BY id DESC LIMIT ?").all(limit) as unknown as LoginRow[];
}

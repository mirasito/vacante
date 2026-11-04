// База SQLite: один файл на сервере в Казахстане. Миграции лежат в server/migrations
// и применяются по порядку имён при каждом запуске, каждая в своей транзакции.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export type Db = DatabaseSync;

export const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));

export function openDb(file: string, migrationsDir = MIGRATIONS): Db {
  const db = new DatabaseSync(file);
  // WAL: чтение не ждёт записи; busy_timeout: короткие блокировки ждём, а не падаем
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db, migrationsDir);
  return db;
}

/** Применяет новые миграции и возвращает их имена. */
export function migrate(db: Db, dir = MIGRATIONS): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))",
  );
  const done = new Set(
    (db.prepare("SELECT name FROM migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const applied: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    const sql = readFileSync(join(dir, name), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO migrations (name) VALUES (?)").run(name);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Миграция ${name} не применилась: ${(err as Error).message}`);
    }
    applied.push(name);
  }
  return applied;
}

/** Выполняет fn в транзакции: всё или ничего. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

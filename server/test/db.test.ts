import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { migrate, MIGRATIONS, openDb } from "../src/db.ts";

const tables = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
    (r) => r.name,
  );

test("миграции применяются один раз, база в режиме WAL", () => {
  const dir = mkdtempSync(join(tmpdir(), "vacante-db-"));
  try {
    const file = join(dir, "vacante.db");
    const db = openDb(file);
    assert.deepEqual(migrate(db), []);
    db.close();
    const again = openDb(file);
    const names = (again.prepare("SELECT name FROM migrations").all() as { name: string }[]).map((r) => r.name);
    assert.ok(names.includes("0001_init.sql"));
    assert.equal((again.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("сломанная миграция откатывается целиком, прошлые остаются", () => {
  const dir = mkdtempSync(join(tmpdir(), "vacante-mig-"));
  try {
    writeFileSync(join(dir, "0001_ok.sql"), "CREATE TABLE a (x INTEGER);");
    writeFileSync(join(dir, "0002_bad.sql"), "CREATE TABLE b (x INTEGER); INSERT INTO nope VALUES (1);");
    const db = new DatabaseSync(":memory:");
    assert.throws(() => migrate(db, dir), /0002_bad\.sql/);
    assert.deepEqual(tables(db), ["a", "migrations"]);
    const done = (db.prepare("SELECT name FROM migrations").all() as { name: string }[]).map((r) => r.name);
    assert.deepEqual(done, ["0001_ok.sql"]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("галочку превью, включённую до кружка в превью, снимает миграция 0008", () => {
  const dir = mkdtempSync(join(tmpdir(), "vacante-mig-"));
  try {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    for (const name of all.filter((f) => f < "0008")) copyFileSync(join(MIGRATIONS, name), join(dir, name));
    const db = new DatabaseSync(":memory:");
    migrate(db, dir);
    db.prepare(
      "INSERT INTO seekers (id, first_name, consent_version, consent_at, preview_at) VALUES (1, 'Дана', 'v', '2026-11-04T23:00:00Z', '2026-11-04T23:00:00Z')",
    ).run();
    copyFileSync(join(MIGRATIONS, "0008_preview_video.sql"), join(dir, "0008_preview_video.sql"));
    assert.deepEqual(migrate(db, dir), ["0008_preview_video.sql"]);
    assert.equal((db.prepare("SELECT preview_at AS at FROM seekers WHERE id = 1").get() as { at: string | null }).at, null);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

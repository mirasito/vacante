import assert from "node:assert/strict";
import { test } from "node:test";
import { RateLimit } from "../src/limits.ts";

test("RateLimit: наплыв новых адресов не снимает блокировку с уже заблокированного", () => {
  const limit = new RateLimit(9, 15 * 60_000);
  const t0 = 1_000_000;
  for (let i = 0; i < 9; i++) assert.equal(limit.take("1.2.3.4", t0), true);
  assert.equal(limit.take("1.2.3.4", t0), false);
  // Раньше 10 001 новый ключ очищал карту целиком, и счётчик подбора начинался заново
  for (let i = 0; i < 25_000; i++) limit.take(`10.0.${i >> 8}.${i & 255}`, t0 + 1000);
  assert.equal(limit.take("1.2.3.4", t0 + 2000, 0), false);
  // Когда окно кончилось, адрес снова может пробовать
  assert.equal(limit.take("1.2.3.4", t0 + 15 * 60_000, 0), true);
});

test("RateLimit: ключи с кончившимся окном убираются, карта не растёт без конца", () => {
  const limit = new RateLimit(1, 60_000);
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 12_000; i++) limit.take(`r${round}-${i}`, round * 120_000);
  }
  const size = (limit as unknown as { hits: Map<string, unknown> }).hits.size;
  assert.ok(size <= 24_000, `ключей ${size}`);
});

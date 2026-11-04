import assert from "node:assert/strict";
import { test } from "node:test";

import { INIT_DATA_MAX_AGE, internalKey, verifyInitData } from "../src/telegram.ts";
import { AIGERIM, NOW, TOKEN, initDataFor, signInitData } from "./helpers.ts";

test("принимает данные, подписанные Telegram", () => {
  const data = verifyInitData(initDataFor(AIGERIM, NOW / 1000 - 10, { start_param: "almaty" }), TOKEN, NOW);
  assert.ok(data);
  assert.equal(data.user.id, 7001);
  assert.equal(data.user.first_name, "Айгерим");
  assert.equal(data.startParam, "almaty");
});

test("поле signature из Bot API 8.0 входит в подпись", () => {
  const raw = signInitData({ auth_date: String(NOW / 1000 - 5), user: JSON.stringify(AIGERIM), signature: "c2lnbmF0dXJl" });
  assert.ok(verifyInitData(raw, TOKEN, NOW));
});

test("не принимает чужую подпись, правку и мусор", () => {
  const raw = initDataFor(AIGERIM);
  assert.equal(verifyInitData(raw, "999:another-token-another-token-xx", NOW), null);
  const forged = raw.replace(encodeURIComponent('"id":7001'), encodeURIComponent('"id":7002'));
  assert.notEqual(forged, raw);
  assert.equal(verifyInitData(forged, TOKEN, NOW), null);
  assert.equal(verifyInitData("", TOKEN, NOW), null);
  assert.equal(verifyInitData("hash=zz&user=1", TOKEN, NOW), null);
});

test("устаревшие данные не принимает", () => {
  assert.equal(verifyInitData(initDataFor(AIGERIM, NOW / 1000 - INIT_DATA_MAX_AGE - 1), TOKEN, NOW), null);
  assert.equal(verifyInitData(initDataFor(AIGERIM, NOW / 1000 + 3600), TOKEN, NOW), null);
});

test("без пользователя или с кривым id не пускает", () => {
  const noUser = signInitData({ auth_date: String(NOW / 1000), query_id: "x" });
  assert.equal(verifyInitData(noUser, TOKEN, NOW), null);
  const badId = initDataFor({ id: "7001", first_name: "A" });
  assert.equal(verifyInitData(badId, TOKEN, NOW), null);
});

test("внутренний ключ одинаковый для одного токена и разный для разных", () => {
  assert.equal(internalKey(TOKEN), internalKey(TOKEN));
  assert.notEqual(internalKey(TOKEN), internalKey("1:other"));
  assert.match(internalKey(TOKEN), /^[0-9a-f]{64}$/);
});

// Ключи в заголовке Authorization: Bearer <ключ>. Сравнение за постоянное время, чтобы ключ
// нельзя было подобрать по времени ответа.
// - внутренний ключ (internalKey: считается из токена бота) — бот, сбор в GitHub Actions;
// - пароль админки (секрет ADMIN_PASSWORD, в конфиге crmKey) — vacante.kz/admin/.
import { timingSafeEqual } from "node:crypto";

import type { Ctx } from "./app.ts";
import { HttpError, type Request } from "./http.ts";
import { internalKey } from "./telegram.ts";

export const bearer = (req: Request) => (req.header("authorization") ?? "").replace(/^Bearer /, "");

export function sameKey(given: string, key: string | Buffer): boolean {
  const g = Buffer.from(given);
  const k = typeof key === "string" ? Buffer.from(key) : key;
  return g.length === k.length && timingSafeEqual(g, k);
}

/** Проверка внутреннего ключа: 403 «Нет доступа». */
export function internalGuard(ctx: Ctx): (req: Request) => void {
  const key = Buffer.from(internalKey(ctx.config.botToken));
  return (req) => {
    if (!sameKey(bearer(req), key)) throw new HttpError(403, "Нет доступа");
  };
}

/** Проверка пароля админки: 503, пока секрета нет (what — что не настроено), и 403 при неверном пароле. */
export function adminGuard(ctx: Ctx, what = "Админка"): (req: Request) => void {
  return (req) => {
    const key = ctx.config.crmKey;
    if (!key) throw new HttpError(503, `${what} не настроена: нет секрета ADMIN_PASSWORD`);
    if (!sameKey(bearer(req), key)) throw new HttpError(403, "Неверный пароль админки");
  };
}

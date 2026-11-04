// Адреса /me: только свои данные и только после входа через Telegram (заголовок Authorization: tma …).
import type { Ctx } from "./app.ts";
import { HttpError, route, type Request, type Route } from "./http.ts";
import { CONSENT_VERSION, parseProfile } from "./profile.ts";
import {
  askPhone,
  cancelPhoneAsk,
  createSeeker,
  deleteSeeker,
  dropSharedLink,
  getSeeker,
  listViews,
  newSharedLink,
  profileView,
  saveProfile,
  setBaseConsent,
  setWriteAccess,
  touchSeeker,
  PHONE_ASK_MINUTES,
} from "./seekers.ts";
import { tx } from "./db.ts";

type Lang = "ru" | "kk";
const langOf = (value: unknown, fallback?: string): Lang => (value === "kk" || (value === undefined && fallback === "kk") ? "kk" : "ru");

export function meRoutes(ctx: Ctx): Route[] {
  /** Соискатель, который уже дал согласие; иначе 404, чтобы приложение предложило создать профиль. */
  const seekerOf = (req: Request) => {
    const { user } = ctx.auth(req);
    const seeker = getSeeker(ctx.db, user.id);
    if (!seeker) throw new HttpError(404, "Профиля ещё нет");
    return seeker;
  };

  return [
    // Кто вошёл и можно ли ему создать профиль. До согласия ничего не записываем
    route("GET", "api", "/me", (req) => {
      const { user } = ctx.auth(req);
      const seeker = getSeeker(ctx.db, user.id);
      if (seeker) touchSeeker(ctx.db, user.id, { first_name: user.first_name }, ctx.now());
      return {
        json: {
          user: { id: user.id, first_name: user.first_name, language_code: user.language_code },
          open: ctx.config.profilesOpen,
          profile: !!seeker,
        },
      };
    }),

    route("GET", "api", "/me/profile", (req) => {
      const seeker = seekerOf(req);
      return { json: profileView(ctx.db, seeker.id, ctx.config.profileOrigin) };
    }),

    // Анкета целиком. Первый раз только с согласием: версия текста, 18 лет и, по желанию, база кандидатов
    route("PUT", "api", "/me/profile", async (req) => {
      const { user } = ctx.auth(req);
      const body = (await req.json<Record<string, unknown>>()) ?? {};
      const profile = parseProfile(body.profile);
      const now = ctx.now();
      const existing = getSeeker(ctx.db, user.id);
      tx(ctx.db, () => {
        if (!existing) {
          if (!ctx.config.profilesOpen && req.header("x-vacante-beta") !== "1") {
            throw new HttpError(403, "Профили пока открыты только для тестирования");
          }
          const consent = body.consent as { version?: unknown; adult?: unknown; base?: unknown } | undefined;
          if (consent?.version !== CONSENT_VERSION) throw new HttpError(400, "Нужно согласие с текущим текстом");
          if (consent.adult !== true) throw new HttpError(400, "Профиль можно создать с 18 лет");
          createSeeker(ctx.db, {
            id: user.id,
            first_name: user.first_name,
            lang: langOf(body.lang, user.language_code),
            consent_version: CONSENT_VERSION,
            base: consent.base === true,
            now,
          });
        } else {
          touchSeeker(ctx.db, user.id, { lang: body.lang === undefined ? undefined : langOf(body.lang) }, now);
        }
        saveProfile(ctx.db, user.id, profile, now);
      });
      return { status: existing ? 200 : 201, json: profileView(ctx.db, user.id, ctx.config.profileOrigin) };
    }),

    // Мелкие настройки: язык, база кандидатов, разрешение боту писать
    route("PATCH", "api", "/me", async (req) => {
      const seeker = seekerOf(req);
      const body = (await req.json<Record<string, unknown>>()) ?? {};
      const now = ctx.now();
      if (body.lang !== undefined) touchSeeker(ctx.db, seeker.id, { lang: langOf(body.lang) }, now);
      if (typeof body.base === "boolean") setBaseConsent(ctx.db, seeker.id, body.base, now);
      if (typeof body.write_access === "boolean") setWriteAccess(ctx.db, seeker.id, body.write_access);
      return { json: profileView(ctx.db, seeker.id, ctx.config.profileOrigin) };
    }),

    // «Удалить профиль»: сразу и целиком, вместе с кружком и ссылками
    route("DELETE", "api", "/me", (req) => {
      const seeker = seekerOf(req);
      deleteSeeker(ctx.db, seeker.id, ctx.config.videosDir);
      return { json: { deleted: true } };
    }),

    // Приложение сейчас откроет окно Telegram «Поделиться номером»: номер придёт боту сообщением,
    // и бот передаст его сюда (internal.ts). Отметка нужна, чтобы этот контакт не ушёл в отклик
    route("POST", "api", "/me/phone/ask", (req) => {
      const seeker = seekerOf(req);
      if (!askPhone(ctx.db, seeker.id, ctx.now())) throw new HttpError(409, "Сначала заполните анкету");
      return { json: { ok: true, minutes: PHONE_ASK_MINUTES } };
    }),

    route("DELETE", "api", "/me/phone/ask", (req) => {
      cancelPhoneAsk(ctx.db, seekerOf(req).id);
      return { json: { ok: true } };
    }),

    route("POST", "api", "/me/link", (req) => {
      const seeker = seekerOf(req);
      const code = newSharedLink(ctx.db, seeker.id, ctx.now());
      return { status: 201, json: { code, url: `${ctx.config.profileOrigin}/${code}` } };
    }),

    route("DELETE", "api", "/me/link", (req) => {
      const seeker = seekerOf(req);
      dropSharedLink(ctx.db, seeker.id);
      return { json: { ok: true } };
    }),

    route("GET", "api", "/me/views", (req) => {
      const seeker = seekerOf(req);
      return { json: { views: listViews(ctx.db, seeker.id) } };
    }),
  ];
}

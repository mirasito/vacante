// Адреса /me: только свои данные и только после входа через Telegram (заголовок Authorization: tma …).
import type { Ctx } from "./app.ts";
import {
  applicationText,
  applicationView,
  deleteApplication,
  ensureLink,
  importApplications,
  listApplications,
  parseImport,
  parsePatch,
  parseVacancy,
  patchApplication,
  summary,
  upsertApplication,
  VACANCY_ID,
} from "./applications.ts";
import { fetchPostContacts, LookupLimit, POST_URL } from "./contacts.ts";
import { find2gisLink, resolve2gis, roundHome } from "./geo.ts";
import { HttpError, route, type Request, type Route } from "./http.ts";
import { RateLimit } from "./limits.ts";
import { cleanJpeg, MAX_PHOTO_BYTES } from "./photo.ts";
import { CONSENT_VERSION, parseProfile } from "./profile.ts";
import { achievementsSeen, importGoal, parseGoal, setGoal } from "./progress.ts";
import {
  actOn,
  addCustom,
  getSettings,
  listReminders,
  parseAction,
  parseCustom,
  parseSettings,
  planReminders,
  saveSettings,
} from "./reminders.ts";
import {
  askPhone,
  cancelPhoneAsk,
  createSeeker,
  deleteSeeker,
  dropPhoto,
  dropSharedLink,
  dropVideo,
  getPhoto,
  getProfile,
  getSeeker,
  getVideo,
  listViews,
  newSharedLink,
  profileView,
  putPhoto,
  randomCode,
  removeFiles,
  saveProfile,
  setBaseConsent,
  setPreview,
  setWriteAccess,
  touchSeeker,
  PHONE_ASK_MINUTES,
} from "./seekers.ts";
import { tx } from "./db.ts";
import { fileReply, writeAtomic } from "./video.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
  const appId = (req: Request) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, "Отклика нет");
    return id;
  };
  const reminderId = (req: Request) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, "Напоминания нет");
    return id;
  };
  /** Вкладка «Напоминания» целиком: что ждёт, история, счётчик и настройки. */
  const reminders = (seekerId: number, now: number) => ({
    ...listReminders(ctx.db, seekerId, now),
    settings: getSettings(ctx.db, seekerId),
  });
  const origin = ctx.config.profileOrigin;
  // Номера из постов: 30 разных вакансий в день и не больше 6 запросов в минуту на человека
  const lookups = new LookupLimit(30);
  const burst = new RateLimit(6, 60_000);
  // Ссылки 2ГИС: 20 в час на человека, каждая — до пяти запросов к 2ГИС
  const homeLinks = new RateLimit(20, 3_600_000);
  // Фото: 30 загрузок в час, чтобы случайный цикл в приложении не забил диск
  const photos = new RateLimit(30, 3_600_000);

  return [
    // Кто вошёл и можно ли ему создать профиль. До согласия ничего не записываем
    route("GET", "api", "/me", (req) => {
      const { user } = ctx.auth(req);
      const seeker = getSeeker(ctx.db, user.id);
      if (seeker) touchSeeker(ctx.db, user.id, { first_name: user.first_name }, ctx.now());
      const home = seeker ? getProfile(ctx.db, user.id)?.home : null;
      return {
        json: {
          user: { id: user.id, first_name: user.first_name, language_code: user.language_code },
          open: ctx.config.profilesOpen,
          profile: !!seeker,
          // Дом из анкеты, округлённый до 300–500 м: лента считает по нему, далеко ли работа. Только самому человеку
          home: home ? { lat: home.lat, lon: home.lon } : null,
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
      // Приложение до 2026-11-04.2 про дом не знает: правка анкеты из него не стирает точку
      if ((body.profile as Record<string, unknown>).home === undefined) profile.home = getProfile(ctx.db, user.id)?.home ?? null;
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

    // Мелкие настройки: язык, база кандидатов, фото в превью ссылки, разрешение боту писать
    route("PATCH", "api", "/me", async (req) => {
      const seeker = seekerOf(req);
      const body = (await req.json<Record<string, unknown>>()) ?? {};
      const now = ctx.now();
      if (body.lang !== undefined) touchSeeker(ctx.db, seeker.id, { lang: langOf(body.lang) }, now);
      if (typeof body.base === "boolean") setBaseConsent(ctx.db, seeker.id, body.base, now);
      if (typeof body.preview === "boolean") setPreview(ctx.db, seeker.id, body.preview, now);
      if (typeof body.write_access === "boolean") setWriteAccess(ctx.db, seeker.id, body.write_access);
      return { json: profileView(ctx.db, seeker.id, ctx.config.profileOrigin) };
    }),

    // «Удалить профиль»: сразу и целиком, вместе с кружком и ссылками
    route("DELETE", "api", "/me", (req) => {
      const seeker = seekerOf(req);
      deleteSeeker(ctx.db, seeker.id, ctx.config.videosDir);
      return { json: { deleted: true } };
    }),

    // Свой кружок в приложении: файл и обложка (запись — в чате бота, internal.ts)
    route("GET", "api", "/me/video", (req) => {
      const video = getVideo(ctx.db, seekerOf(req).id);
      if (!video?.file) throw new HttpError(404, "Кружка нет");
      return fileReply(req, join(ctx.config.videosDir, video.file), "video/mp4");
    }),

    route("GET", "api", "/me/video/poster", (req) => {
      const video = getVideo(ctx.db, seekerOf(req).id);
      if (!video?.poster) throw new HttpError(404, "Обложки нет");
      return fileReply(req, join(ctx.config.videosDir, video.poster), "image/jpeg");
    }),

    route("DELETE", "api", "/me/video", (req) => {
      const seeker = seekerOf(req);
      dropVideo(ctx.db, seeker.id, ctx.config.videosDir);
      return { json: profileView(ctx.db, seeker.id, ctx.config.profileOrigin) };
    }),

    // Фото: приложение присылает JPEG как есть (Content-Type: image/jpeg), сервер вычищает метаданные
    route("PUT", "api", "/me/photo", async (req) => {
      const seeker = seekerOf(req);
      const now = ctx.now();
      if (!photos.take(String(seeker.id), now)) throw new HttpError(429, "Слишком часто, подождите немного");
      const photo = cleanJpeg(await req.bytes(MAX_PHOTO_BYTES));
      if (!photo) throw new HttpError(400, "Нужно фото JPEG от 100 до 2560 точек по стороне");
      const dir = ctx.config.videosDir;
      const file = `${seeker.id}-${randomCode()}-photo.jpg`;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeAtomic(join(dir, file), photo.data);
      const old = putPhoto(ctx.db, seeker.id, { file, width: photo.width, height: photo.height, size: photo.data.length }, now);
      if (old === false) {
        removeFiles(dir, [file]);
        throw new HttpError(409, "Сначала заполните анкету");
      }
      removeFiles(dir, [old]);
      return { json: profileView(ctx.db, seeker.id, ctx.config.profileOrigin) };
    }),

    route("GET", "api", "/me/photo", (req) => {
      const photo = getPhoto(ctx.db, seekerOf(req).id);
      if (!photo) throw new HttpError(404, "Фото нет");
      return fileReply(req, join(ctx.config.videosDir, photo.file), "image/jpeg");
    }),

    route("DELETE", "api", "/me/photo", (req) => {
      const seeker = seekerOf(req);
      dropPhoto(ctx.db, seeker.id, ctx.config.videosDir);
      return { json: profileView(ctx.db, seeker.id, ctx.config.profileOrigin) };
    }),

    // Дом по ссылке из 2ГИС: точка (округлённая) и подпись 2ГИС, чтобы человек проверил, что нашли
    // его дом. Ничего не записывается: точка попадёт в профиль вместе с анкетой. Профиль не нужен,
    // ссылку вставляют ещё в анкете
    route("POST", "api", "/me/home/link", async (req) => {
      const { user } = ctx.auth(req);
      const body = (await req.json<Record<string, unknown>>()) ?? {};
      const text = typeof body.link === "string" ? body.link.slice(0, 2000) : "";
      if (!find2gisLink(text)) throw new HttpError(400, "Это не ссылка 2ГИС");
      if (!homeLinks.take(String(user.id), ctx.now())) throw new HttpError(429, "Слишком часто, подождите немного");
      let found;
      try {
        found = await resolve2gis(ctx.fetch, text);
      } catch (err) {
        console.warn(`ссылка 2ГИС: ${err instanceof Error ? err.message : err}`);
        throw new HttpError(502, "2ГИС не ответил, попробуйте ещё раз");
      }
      if (!found) throw new HttpError(422, "Не нашли дом по этой ссылке");
      return { json: { lat: roundHome(found.lat), lon: roundHome(found.lon), source: "2gis", label: found.label } };
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

    // Отклики со сводкой недели и общей стадией поиска
    route("GET", "api", "/me/applications", (req) => {
      const seeker = seekerOf(req);
      const now = ctx.now();
      return {
        json: { applications: listApplications(ctx.db, seeker.id, origin, now), summary: summary(ctx.db, seeker.id, now) },
      };
    }),

    // «Хочу сюда»: отклик со стадией «Нравится», его своя ссылка на профиль и готовый текст сообщения.
    // Повторный вызов для той же вакансии вернёт тот же отклик, а истёкшую ссылку заменит новой
    route("POST", "api", "/me/applications", async (req) => {
      const seeker = seekerOf(req);
      const body = (await req.json<Record<string, unknown>>()) ?? {};
      const vacancy = parseVacancy(body.vacancy);
      const lang = langOf(body.lang, seeker.lang);
      const now = ctx.now();
      const { id, created } = upsertApplication(ctx.db, seeker.id, vacancy, now);
      const code = ensureLink(ctx.db, seeker.id, id, now);
      const profile = getProfile(ctx.db, seeker.id);
      const title = (lang === "kk" && vacancy.title_kk) || vacancy.title;
      const message = profile
        ? applicationText(profile, title, `${origin}/${code}`, !!getVideo(ctx.db, seeker.id)?.file, lang)
        : null;
      return {
        status: created ? 201 : 200,
        json: { application: applicationView(ctx.db, seeker.id, id, origin, now), message },
      };
    }),

    // Лайки и отклики, которые человек сделал на телефоне до профиля
    route("POST", "api", "/me/applications/import", async (req) => {
      const seeker = seekerOf(req);
      const now = ctx.now();
      const imported = importApplications(ctx.db, seeker.id, parseImport(await req.json(), now), now);
      return {
        json: {
          imported,
          applications: listApplications(ctx.db, seeker.id, origin, now),
          summary: summary(ctx.db, seeker.id, now),
        },
      };
    }),

    // Один отклик с историей стадий
    route("GET", "api", "/me/applications/:id", (req) => {
      const seeker = seekerOf(req);
      const view = applicationView(ctx.db, seeker.id, appId(req), origin, ctx.now());
      if (!view) throw new HttpError(404, "Отклика нет");
      return { json: view };
    }),

    // Стадия, способ, дата собеседования, день выхода, заметка
    route("PATCH", "api", "/me/applications/:id", async (req) => {
      const seeker = seekerOf(req);
      const id = appId(req);
      const now = ctx.now();
      const patch = parsePatch(await req.json(), now);
      if (!patchApplication(ctx.db, seeker.id, id, patch, "seeker", now)) throw new HttpError(404, "Отклика нет");
      // Новая дата собеседования сразу даёт новые напоминания, а прежние о нём отменяются
      planReminders(ctx.db, seeker.id, now);
      return {
        json: { application: applicationView(ctx.db, seeker.id, id, origin, now), summary: summary(ctx.db, seeker.id, now) },
      };
    }),

    // Цель недели: 3, 5 или 10 откликов, null выключает. Ответ — сводка с кольцом и серией
    route("PUT", "api", "/me/goal", async (req) => {
      const seeker = seekerOf(req);
      const now = ctx.now();
      setGoal(ctx.db, seeker.id, parseGoal(await req.json()), now);
      return { json: { summary: summary(ctx.db, seeker.id, now) } };
    }),

    // Цель с телефона, заведённая до профиля: ложится, только если на сервере цели ещё не было
    route("POST", "api", "/me/goal/import", async (req) => {
      const seeker = seekerOf(req);
      const now = ctx.now();
      importGoal(ctx.db, seeker.id, await req.json(), now);
      return { json: { summary: summary(ctx.db, seeker.id, now) } };
    }),

    // Приложение поздравило с новыми достижениями: второй раз не показываем
    route("POST", "api", "/me/achievements/seen", (req) => {
      achievementsSeen(ctx.db, seekerOf(req).id);
      return { json: { ok: true } };
    }),

    // Удалить отклик: его ссылка на профиль сразу перестаёт открываться
    route("DELETE", "api", "/me/applications/:id", (req) => {
      const seeker = seekerOf(req);
      if (!deleteApplication(ctx.db, seeker.id, appId(req))) throw new HttpError(404, "Отклика нет");
      return { json: { deleted: true, summary: summary(ctx.db, seeker.id, ctx.now()) } };
    }),

    // Напоминания: системные сервер сверяет с откликами и профилем при каждом запросе
    route("GET", "api", "/me/reminders", (req) => {
      const seeker = seekerOf(req);
      const now = ctx.now();
      planReminders(ctx.db, seeker.id, now);
      return { json: reminders(seeker.id, now) };
    }),

    // «Добавить своё»: текст и время
    route("POST", "api", "/me/reminders", async (req) => {
      const seeker = seekerOf(req);
      const now = ctx.now();
      const id = addCustom(ctx.db, seeker.id, parseCustom(await req.json(), now), now);
      return { status: 201, json: { id, ...reminders(seeker.id, now) } };
    }),

    // Какие напоминания присылать и присылать ли их в бот
    route("PUT", "api", "/me/reminders/settings", async (req) => {
      const seeker = seekerOf(req);
      const now = ctx.now();
      saveSettings(ctx.db, seeker.id, parseSettings(await req.json()), now);
      return { json: reminders(seeker.id, now) };
    }),

    // «Готово», «Отложить» или «Убрать»
    route("PATCH", "api", "/me/reminders/:id", async (req) => {
      const seeker = seekerOf(req);
      const id = reminderId(req);
      const now = ctx.now();
      if (!actOn(ctx.db, seeker.id, id, parseAction(await req.json(), now), now)) throw new HttpError(404, "Напоминания нет");
      return { json: reminders(seeker.id, now) };
    }),

    // Номер для WhatsApp и звонка или имя в Telegram из исходного поста, только в момент отклика.
    // Найденное сразу уходит в ответ и нигде не записывается. Профиль для этого не нужен
    route("POST", "api", "/me/contact", async (req) => {
      const { user } = ctx.auth(req);
      const body = (await req.json<Record<string, unknown>>()) ?? {};
      const vacancyId = typeof body.vacancy_id === "string" && VACANCY_ID.test(body.vacancy_id) ? body.vacancy_id : null;
      const sourceUrl = typeof body.source_url === "string" && POST_URL.test(body.source_url) ? body.source_url : null;
      if (!vacancyId || !sourceUrl) throw new HttpError(400, "Номер можно узнать только у поста из канала");
      const now = ctx.now();
      if (!burst.take(String(user.id), now)) throw new HttpError(429, "Слишком часто, подождите минуту");
      const quota = lookups.take(user.id, vacancyId, now);
      if (!quota.ok) throw new HttpError(429, `Не больше ${lookups.perDay} вакансий с номером в день`);
      let found;
      try {
        found = await fetchPostContacts(ctx.fetch, sourceUrl);
      } catch (err) {
        lookups.refund(user.id, vacancyId);
        console.warn(`пост ${sourceUrl}: ${err instanceof Error ? err.message : err}`);
        throw new HttpError(502, "Telegram не ответил, попробуйте ещё раз");
      }
      return {
        json: {
          whatsapp: found?.whatsapp ?? null,
          phone: found?.phone ?? null,
          telegram: found?.telegram ?? null,
          left: quota.left,
        },
      };
    }),
  ];
}

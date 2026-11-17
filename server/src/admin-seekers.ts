// Соискатели для админки vacante.kz/admin/ (вкладка «Соискатели»): все заполненные профили с анкетой,
// телефоном, фото, кружком и откликами. Только под паролем админки (CRM_KEY) и только чтение.
//
// Профиль открывается в самой админке, а не по ссылке p.vacante.kz: просмотр ссылки записывается
// и приходит человеку в бот («ваш профиль посмотрели»), а владелец сайта работодателем не является.
// Фото и кружок отдаются отдельными запросами с тем же ключом. Точка дома в админку не идёт.
import { join } from "node:path";

import type { Ctx } from "./app.ts";
import { adminGuard } from "./auth.ts";
import { HttpError, route, type Request, type Route } from "./http.ts";
import {
  cityName, documentsLabel, employmentLabel, experienceLabel, jobTermLabel, languagesLabel, payLabel,
  phoneLabel, skillLabel, startLabel,
} from "./labels.ts";
import { fromRow, isLooking } from "./profile.ts";
import { getPhoto, getVideo } from "./seekers.ts";
import { fileReply } from "./video.ts";

const STAGE: Record<string, string> = {
  liked: "Смотрю", sent: "Отправлен", seen: "Просмотрен", invited: "Пригласили", interview: "Собеседование",
  offer: "Предложение", hired: "Вышел на работу", rejected: "Отказ", no_answer: "Нет ответа", not_interested: "Не интересно",
};

export function adminSeekerRoutes(ctx: Ctx): Route[] {
  const admin = adminGuard(ctx);
  const idOf = (req: Request) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, "Нет такого соискателя");
    return id;
  };

  const list = ctx.db.prepare(
    `SELECT s.id, s.first_name, s.lang, s.created_at, s.seen_at, s.base_consent_at, s.source, p.*,
       (SELECT COUNT(*) FROM applications a WHERE a.seeker_id = s.id AND a.sent_at IS NOT NULL) AS sent,
       (SELECT MAX(a.sent_at) FROM applications a WHERE a.seeker_id = s.id) AS last_sent,
       (SELECT COUNT(*) FROM applications a WHERE a.seeker_id = s.id AND a.stage IN ('invited', 'interview', 'offer', 'hired')) AS invited,
       (SELECT duration FROM videos v WHERE v.seeker_id = s.id AND v.file IS NOT NULL) AS video,
       EXISTS (SELECT 1 FROM photos f WHERE f.seeker_id = s.id) AS photo
     FROM seekers s JOIN profiles p ON p.seeker_id = s.id
     ORDER BY s.created_at DESC`,
  );
  const applications = ctx.db.prepare(
    `SELECT title, employer, city, method, stage, sent_at, created_at, interview_at, url
     FROM applications WHERE seeker_id = ? ORDER BY coalesce(sent_at, created_at) DESC LIMIT 100`,
  );

  return [
    route("GET", "api", "/admin/seekers", (req) => {
      admin(req);
      const now = ctx.now();
      const seekers = (list.all() as Record<string, unknown>[]).map((r) => {
        const p = fromRow(r);
        return {
          id: Number(r.id),
          name: p.name,
          city: cityName(p.city, "ru"),
          district: p.district,
          roles: p.roles,
          experience: experienceLabel(p, "ru"),
          employment: employmentLabel(p, "ru"),
          pay: payLabel(p, "ru"),
          start: startLabel(p, "ru"),
          phone: p.phone ? phoneLabel(p.phone) : null,
          phone_raw: p.phone,
          languages: languagesLabel(p, "ru") || null,
          documents: documentsLabel(p, "ru"),
          trial: p.trial,
          looking: isLooking(p, now),
          skills: p.skills.map((s) => skillLabel(s, "ru") || s),
          jobs: p.jobs.map((j) => ({ place: j.place, role: j.role, term: jobTermLabel(j.term, "ru") || j.term })),
          about: p.about,
          home: !!p.home,
          lang: r.lang,
          base: !!r.base_consent_at,
          source: r.source ?? null,
          created_at: r.created_at,
          updated_at: r.updated_at,
          seen_at: r.seen_at,
          sent: Number(r.sent),
          invited: Number(r.invited),
          last_sent: r.last_sent ?? null,
          video: r.video === null || r.video === undefined ? null : Number(r.video),
          photo: !!r.photo,
        };
      });
      return { headers: { "Cache-Control": "no-store" }, json: { seekers } };
    }),

    route("GET", "api", "/admin/seekers/:id/applications", (req) => {
      admin(req);
      const rows = (applications.all(idOf(req)) as Record<string, unknown>[]).map((a) => ({ ...a, stage: STAGE[a.stage as string] ?? a.stage }));
      return { headers: { "Cache-Control": "no-store" }, json: { applications: rows } };
    }),

    route("GET", "api", "/admin/seekers/:id/photo.jpg", (req) => {
      admin(req);
      const name = getPhoto(ctx.db, idOf(req))?.file;
      if (!name) throw new HttpError(404, "Нет фото");
      const reply = fileReply(req, join(ctx.config.videosDir, name), "image/jpeg");
      return { ...reply, headers: { ...reply.headers, "Cache-Control": "no-store" } };
    }),

    route("GET", "api", "/admin/seekers/:id/video.mp4", (req) => {
      admin(req);
      const name = getVideo(ctx.db, idOf(req))?.file;
      if (!name) throw new HttpError(404, "Нет кружка");
      const reply = fileReply(req, join(ctx.config.videosDir, name), "video/mp4");
      return { ...reply, headers: { ...reply.headers, "Cache-Control": "no-store" } };
    }),
  ];
}

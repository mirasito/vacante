// CRM работодателей для админки vacante.kz/admin/ (вкладка «Работодатели»). Главная карточка — работодатель,
// внутри неё карточки его заведений, у заведений вакансии (сейчас на сайте и архив).
//
// Этап 1: данные заполняет часовой сбор на GitHub (vacante/crm_sync.py) через POST /internal/crm/import
// с внутренним ключом из токена бота, админка только смотрит: GET /admin/crm и /admin/crm/:id с ключом
// sha256("crm:" + пароль админки), тем же, что у CRM в воркере бота (bot/src/crm.js). Его считает выкладка
// (server.yml) из секрета ADMIN_PASSWORD; сам пароль на сервер не попадает.
//
// Здесь только то, что и так открыто: названия, города, адреса из вакансий, ссылки компании, которые нашёл
// агент «Заведения», и сами вакансии. Контактов людей нет.
import { timingSafeEqual } from "node:crypto";

import type { Ctx } from "./app.ts";
import { tx } from "./db.ts";
import { HttpError, route, type Request, type Route } from "./http.ts";
import { internalKey } from "./telegram.ts";

const BODY_LIMIT = 8 * 1024 * 1024;
const ARCHIVE = 30; // снятых вакансий в карточке заведения
const SOURCES = new Set(["telegram", "hh", "olx", "bot"]);

interface VacancyIn {
  id: string;
  title: string;
  category?: string | null;
  salary?: string | null;
  source: string;
  posted_at: string;
  top_until?: string | null;
}

interface VenueIn {
  key: string;
  name: string;
  city?: string | null;
  address?: string | null;
  lat?: number | null;
  lon?: number | null;
  instagram?: string | null;
  telegram?: string | null;
  website?: string | null;
  avatar?: string | null;
  twogis?: string | null;
  agent_status?: string | null;
  vacancies: VacancyIn[];
}

interface EmployerIn {
  key: string;
  name: string;
  venues: VenueIn[];
}

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function cleanVacancy(v: unknown): VacancyIn | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id, 80);
  const title = str(o.title, 200);
  const source = str(o.source, 20);
  const posted = str(o.posted_at, 40);
  if (!id || !title || !source || !SOURCES.has(source) || !posted || !ISO.test(posted)) return null;
  const top = str(o.top_until, 40);
  return {
    id, title, source, posted_at: posted,
    category: str(o.category, 40), salary: str(o.salary, 80), top_until: top && ISO.test(top) ? top : null,
  };
}

function cleanVenue(v: unknown): VenueIn | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const key = str(o.key, 200);
  const name = str(o.name, 200);
  if (!key || !name) return null;
  const link = (x: unknown) => {
    const s = str(x, 300);
    return s && !/[\s<>"]/.test(s) ? s : null;
  };
  return {
    key, name,
    city: str(o.city, 40), address: str(o.address, 200), lat: num(o.lat), lon: num(o.lon),
    instagram: str(o.instagram, 60), telegram: str(o.telegram, 60), website: link(o.website),
    avatar: /^[0-9a-f]{16}\.jpg$/.test(String(o.avatar ?? "")) ? String(o.avatar) : null,
    twogis: link(o.twogis), agent_status: str(o.agent_status, 10),
    vacancies: (Array.isArray(o.vacancies) ? o.vacancies : []).map(cleanVacancy).filter((x): x is VacancyIn => !!x),
  };
}

function cleanEmployer(v: unknown): EmployerIn | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const key = str(o.key, 200);
  const name = str(o.name, 200);
  if (!key || !name) return null;
  const venues = (Array.isArray(o.venues) ? o.venues : []).map(cleanVenue).filter((x): x is VenueIn => !!x);
  return venues.length ? { key, name, venues } : null;
}

export function crmRoutes(ctx: Ctx): Route[] {
  const internal = Buffer.from(internalKey(ctx.config.botToken));
  const same = (given: string, key: Buffer) => {
    const g = Buffer.from(given);
    return g.length === key.length && timingSafeEqual(g, key);
  };
  const bearer = (req: Request) => (req.header("authorization") ?? "").replace(/^Bearer /, "");
  const admin = (req: Request) => {
    if (!ctx.config.crmKey) throw new HttpError(503, "CRM не настроена: нет секрета ADMIN_PASSWORD");
    if (!same(bearer(req), Buffer.from(ctx.config.crmKey))) throw new HttpError(403, "Неверный пароль админки");
  };
  const db = ctx.db;

  async function body(req: Request): Promise<Record<string, unknown>> {
    try {
      const parsed = JSON.parse((await req.bytes(BODY_LIMIT)).toString("utf8") || "{}");
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* ниже */
    }
    throw new HttpError(400, "Тело запроса не JSON");
  }

  function runAt(value: unknown): string {
    const at = str(value, 40);
    if (!at || !ISO.test(at) || Number.isNaN(Date.parse(at))) throw new HttpError(400, "Нужен run_at");
    return new Date(at).toISOString();
  }

  const upsertEmployer = db.prepare(
    `INSERT INTO employers (key, name, first_seen, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen RETURNING id`,
  );
  // Работодатель заведения ставится один раз, при первом появлении: потом его будут менять руками
  const upsertVenue = db.prepare(
    `INSERT INTO venues (key, employer_id, name, city, address, lat, lon, instagram, telegram, website, avatar, twogis,
       agent_status, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET name = excluded.name, city = excluded.city,
       address = coalesce(excluded.address, venues.address), lat = coalesce(excluded.lat, venues.lat),
       lon = coalesce(excluded.lon, venues.lon), instagram = excluded.instagram, telegram = excluded.telegram,
       website = excluded.website, avatar = excluded.avatar, twogis = excluded.twogis,
       agent_status = excluded.agent_status, last_seen = excluded.last_seen
     RETURNING id`,
  );
  const upsertVacancy = db.prepare(
    `INSERT INTO employer_vacancies (id, venue_id, title, category, salary, source, posted_at, top_until, first_seen,
       last_seen, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT (id) DO UPDATE SET venue_id = excluded.venue_id, title = excluded.title, category = excluded.category,
       salary = excluded.salary, source = excluded.source, posted_at = excluded.posted_at,
       top_until = excluded.top_until, last_seen = excluded.last_seen, active = 1`,
  );

  return [
    // Часть снимка: до нескольких сотен работодателей с заведениями и вакансиями, которые сейчас на сайте
    route("POST", "api", "/internal/crm/import", async (req) => {
      if (!same(bearer(req), internal)) throw new HttpError(403, "Нет доступа");
      const data = await body(req);
      const at = runAt(data.run_at);
      const employers = (Array.isArray(data.employers) ? data.employers : [])
        .map(cleanEmployer).filter((x): x is EmployerIn => !!x);
      let venues = 0, vacancies = 0;
      tx(db, () => {
        for (const e of employers) {
          const { id: employerId } = upsertEmployer.get(e.key, e.name, at, at) as { id: number };
          for (const v of e.venues) {
            const { id: venueId } = upsertVenue.get(
              v.key, employerId, v.name, v.city ?? null, v.address ?? null, v.lat ?? null, v.lon ?? null,
              v.instagram ?? null, v.telegram ?? null, v.website ?? null, v.avatar ?? null, v.twogis ?? null,
              v.agent_status ?? null, at, at,
            ) as { id: number };
            venues++;
            for (const x of v.vacancies) {
              upsertVacancy.run(x.id, venueId, x.title, x.category ?? null, x.salary ?? null, x.source, x.posted_at,
                x.top_until ?? null, at, at);
              vacancies++;
            }
          }
        }
      });
      return { json: { employers: employers.length, venues, vacancies } };
    }),

    // Снимок целиком дошёл: вакансии, которых в нём не было, уходят в архив
    route("POST", "api", "/internal/crm/finish", async (req) => {
      if (!same(bearer(req), internal)) throw new HttpError(403, "Нет доступа");
      const at = runAt((await body(req)).run_at);
      const archived = db.prepare("UPDATE employer_vacancies SET active = 0 WHERE active = 1 AND last_seen < ?").run(at);
      const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
      return {
        json: {
          archived: Number(archived.changes),
          employers: count("SELECT count(*) AS n FROM employers"),
          venues: count("SELECT count(*) AS n FROM venues"),
          active: count("SELECT count(*) AS n FROM employer_vacancies WHERE active = 1"),
        },
      };
    }),

    // Список работодателей для админки: по строке на работодателя
    route("GET", "api", "/admin/crm", (req) => {
      admin(req);
      const rows = db.prepare(
        `SELECT e.id, e.name, e.first_seen, e.last_seen,
           count(DISTINCT v.id) AS venues,
           group_concat(DISTINCT v.city) AS cities,
           max(v.instagram) AS instagram, max(v.telegram) AS telegram, max(v.website) AS website,
           max(v.avatar) AS avatar,
           (SELECT count(*) FROM employer_vacancies x JOIN venues y ON y.id = x.venue_id
             WHERE y.employer_id = e.id AND x.active = 1) AS active,
           (SELECT count(*) FROM employer_vacancies x JOIN venues y ON y.id = x.venue_id
             WHERE y.employer_id = e.id) AS total,
           (SELECT max(x.posted_at) FROM employer_vacancies x JOIN venues y ON y.id = x.venue_id
             WHERE y.employer_id = e.id) AS last_posted,
           (SELECT group_concat(DISTINCT x.source) FROM employer_vacancies x JOIN venues y ON y.id = x.venue_id
             WHERE y.employer_id = e.id AND x.active = 1) AS sources,
           (SELECT group_concat(DISTINCT x.category) FROM employer_vacancies x JOIN venues y ON y.id = x.venue_id
             WHERE y.employer_id = e.id) AS categories
         FROM employers e JOIN venues v ON v.employer_id = e.id
         GROUP BY e.id`,
      ).all() as Record<string, unknown>[];
      const split = (s: unknown) => (typeof s === "string" && s ? s.split(",") : []);
      return {
        headers: { "Cache-Control": "no-store" },
        json: {
          employers: rows.map((r) => ({
            ...r, cities: split(r.cities), sources: split(r.sources), categories: split(r.categories),
          })),
        },
      };
    }),

    // Карточка работодателя: его заведения, у каждого вакансии на сайте и последние снятые
    route("GET", "api", "/admin/crm/:id", (req) => {
      admin(req);
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "Некорректный id");
      const employer = db.prepare("SELECT id, name, first_seen, last_seen FROM employers WHERE id = ?").get(id);
      if (!employer) throw new HttpError(404, "Работодатель не найден");
      const venues = db.prepare(
        `SELECT id, key, name, city, address, lat, lon, instagram, telegram, website, avatar, twogis, agent_status,
           added_by, first_seen, last_seen FROM venues WHERE employer_id = ? ORDER BY last_seen DESC, name`,
      ).all(id) as Record<string, unknown>[];
      const active = db.prepare(
        `SELECT id, title, category, salary, source, posted_at, top_until, first_seen, last_seen, active
         FROM employer_vacancies WHERE venue_id = ? AND active = 1 ORDER BY posted_at DESC`,
      );
      const archive = db.prepare(
        `SELECT id, title, category, salary, source, posted_at, top_until, first_seen, last_seen, active
         FROM employer_vacancies WHERE venue_id = ? AND active = 0 ORDER BY last_seen DESC LIMIT ${ARCHIVE}`,
      );
      const archived = db.prepare("SELECT count(*) AS n FROM employer_vacancies WHERE venue_id = ? AND active = 0");
      return {
        headers: { "Cache-Control": "no-store" },
        json: {
          employer,
          venues: venues.map((v) => ({
            ...v,
            vacancies: active.all(v.id as number),
            archive: archive.all(v.id as number),
            archived: (archived.get(v.id as number) as { n: number }).n,
          })),
        },
      };
    }),
  ];
}

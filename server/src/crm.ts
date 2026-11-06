// CRM работодателей для админки vacante.kz/admin/ (вкладка «Работодатели»). Главная карточка — работодатель,
// внутри неё карточки его заведений, у заведений вакансии (сейчас на сайте и архив).
//
// Откуда данные:
// - часовой сбор на GitHub (vacante/crm_sync.py): работодатели, заведения и вакансии с сайта, кто разместил
//   вакансии в боте, оплаты из бота и статусы старой «CRM заведений»: POST /internal/crm/import и /finish
//   с внутренним ключом из токена бота; данные компании с открытого API hh: POST /internal/crm/hh;
// - админка: правка, склейка, новые заведения, фото, статус и история: /admin/crm… с ключом
//   sha256("crm:" + пароль админки), как у CRM в воркере бота (bot/src/crm.js). Его считает выкладка
//   (server.yml) из секрета ADMIN_PASSWORD; сам пароль на сервер не попадает;
// - сами работодатели в боте: /company (server/src/crm-bot.ts).
//
// Ручные правки лежат в edits отдельно от того, что приносит сбор, поэтому импорт их не перезаписывает.
// Контактов людей здесь нет, кроме тех, кто сам пишет в бот как работодатель (members).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";

import type { Ctx } from "./app.ts";
import { tx, type Db } from "./db.ts";
import { HttpError, route, type Request, type Route } from "./http.ts";
import { cleanJpeg, MAX_PHOTO_BYTES } from "./photo.ts";
import { randomCode, removeFiles } from "./seekers.ts";
import { internalKey } from "./telegram.ts";
import { fileReply, writeAtomic } from "./video.ts";

const BODY_LIMIT = 8 * 1024 * 1024;
const ARCHIVE = 30; // снятых вакансий в карточке заведения
const SOURCES = new Set(["telegram", "hh", "olx", "bot"]);
export const STATUSES = ["", "sent", "replied", "client", "no"] as const;
export const STATUS_LABEL: Record<string, string> = {
  "": "Не писали", sent: "Написали", replied: "Ответили", client: "Клиент", no: "Отказ",
};
const EMPLOYER_FIELDS = ["name", "legal_name", "bin", "category", "website", "instagram", "telegram", "about"] as const;
const VENUE_FIELDS = ["name", "city", "address", "instagram", "telegram", "website", "twogis"] as const;
const MAX_PHOTOS = 8; // фото на заведение
const HH_RECHECK_DAYS = 30;

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
  hh_id?: string | null;
  venues: VenueIn[];
}

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const link = (x: unknown) => {
  const s = str(x, 300);
  return s && /^https?:\/\/[^\s<>"]+$/i.test(s) ? s : null;
};
const handle = (x: unknown) => {
  const s = str(x, 80)?.toLowerCase().replace(/^https?:\/\/(www\.)?(instagram\.com|t\.me|telegram\.me)\//, "").replace(/^@/, "").replace(/\/.*$/, "");
  return s && /^[a-z0-9._]{2,40}$/.test(s) ? s : null;
};
const parse = (s: unknown): Record<string, string> => {
  try {
    const v = JSON.parse(String(s ?? "{}"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

/** Название без регистра, кавычек и формы собственности: как ключ работодателя в vacante/crm_sync.py. */
export function nameKey(name: string): string {
  return name.toLowerCase().replace(/ё/g, "е").replace(/[«»"“”„'’]/g, "")
    .replace(/^\s*(тоо|ип|ао|оао|зао|ооо|too|llp|ltd)\s+/i, "")
    .replace(/[^\p{L}\p{N}&+]+/gu, " ").trim();
}

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
  if (!key || !name || key.startsWith("manual:")) return null;
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
  const hh = str(o.hh_id, 20);
  return venues.length ? { key, name, hh_id: hh && /^\d+$/.test(hh) ? hh : null, venues } : null;
}

// ---------- Чтение: работодатель и заведение с ручными правками поверх собранного ----------

export function employerView(row: Record<string, unknown>) {
  const e = parse(row.edits);
  return {
    id: row.id as number,
    name: e.name || (row.name as string),
    auto_name: row.name as string,
    legal_name: e.legal_name ?? null, bin: e.bin ?? null, category: e.category ?? null,
    website: e.website ?? null, instagram: e.instagram ?? null, telegram: e.telegram ?? null,
    about: e.about ?? null,
    edited: Object.keys(e),
    status: (row.status as string) ?? "", next_at: row.next_at ?? null, note: (row.note as string) ?? "",
    hh: row.hh_id ? { id: row.hh_id, logo: row.hh_logo ?? null, site: row.hh_site ?? null, about: row.hh_about ?? null } : null,
    first_seen: row.first_seen, last_seen: row.last_seen,
  };
}

export function venueView(row: Record<string, unknown>) {
  const e = parse(row.edits);
  const pick = (f: string) => (f in e ? e[f] || null : (row[f] as string | null) ?? null);
  return {
    id: row.id as number, key: row.key as string, employer_id: row.employer_id as number,
    name: pick("name") ?? (row.name as string), city: pick("city"), address: pick("address"),
    lat: row.lat ?? null, lon: row.lon ?? null,
    instagram: pick("instagram"), telegram: pick("telegram"), website: pick("website"), twogis: pick("twogis"),
    avatar: row.avatar ?? null, agent_status: row.agent_status ?? null,
    added_by: row.added_by as string, review: (row.review as string) ?? "", edited: Object.keys(e),
    first_seen: row.first_seen, last_seen: row.last_seen,
  };
}

export const getEmployer = (db: Db, id: number) =>
  db.prepare("SELECT * FROM employers WHERE id = ?").get(id) as Record<string, unknown> | undefined;

export function logActivity(db: Db, employerId: number, kind: string, text: string, at: string, by = "admin") {
  db.prepare("INSERT INTO activities (employer_id, at, kind, text, by) VALUES (?, ?, ?, ?, ?)")
    .run(employerId, at, kind, text.slice(0, 1000), by);
}

/** Работодатель по ключу названия: с учётом склеек. */
export function employerByKey(db: Db, key: string): number | null {
  const alias = db.prepare("SELECT employer_id FROM employer_aliases WHERE key = ?").get(key) as { employer_id: number } | undefined;
  if (alias) return alias.employer_id;
  const row = db.prepare("SELECT id FROM employers WHERE key = ?").get(key) as { id: number } | undefined;
  return row?.id ?? null;
}

/** Работодатель для вакансии или оплаты из бота: по заведению, если оно уже есть, иначе по названию. */
export function resolveEmployer(db: Db, venueKey: string | null, employerKey: string | null): number | null {
  if (venueKey) {
    const v = db.prepare("SELECT employer_id FROM venues WHERE key = ?").get(venueKey) as { employer_id: number } | undefined;
    if (v) return v.employer_id;
  }
  return employerKey ? employerByKey(db, employerKey) : null;
}

/** Склеивает работодателя from в into: заведения, история, профили, оплаты и старые названия переходят к into. */
export function mergeEmployers(db: Db, from: number, into: number, at: string) {
  if (from === into) throw new HttpError(400, "Это один и тот же работодатель");
  const a = getEmployer(db, from);
  const b = getEmployer(db, into);
  if (!a || !b) throw new HttpError(404, "Работодатель не найден");
  tx(db, () => {
    db.prepare("UPDATE venues SET employer_id = ? WHERE employer_id = ?").run(into, from);
    db.prepare("UPDATE activities SET employer_id = ? WHERE employer_id = ?").run(into, from);
    db.prepare("UPDATE payments SET employer_id = ? WHERE employer_id = ?").run(into, from);
    db.prepare("UPDATE bot_jobs SET employer_id = ? WHERE employer_id = ?").run(into, from);
    db.prepare(
      "INSERT OR IGNORE INTO members (employer_id, tg_chat, name, claimed_at, confirmed_at, rejected_at) " +
        "SELECT ?, tg_chat, name, claimed_at, confirmed_at, rejected_at FROM members WHERE employer_id = ?",
    ).run(into, from);
    db.prepare("DELETE FROM members WHERE employer_id = ?").run(from);
    db.prepare("UPDATE employer_aliases SET employer_id = ? WHERE employer_id = ?").run(into, from);
    db.prepare("INSERT OR REPLACE INTO employer_aliases (key, employer_id) VALUES (?, ?)").run(a.key as string, into);
    // Пустые поля into берут значения from: статус, заметка, данные hh
    if (!b.status && a.status) db.prepare("UPDATE employers SET status = ? WHERE id = ?").run(a.status as string, into);
    if (!b.note && a.note) db.prepare("UPDATE employers SET note = ? WHERE id = ?").run(a.note as string, into);
    if (!b.hh_id && a.hh_id) {
      db.prepare("UPDATE employers SET hh_id = ?, hh_logo = ?, hh_site = ?, hh_about = ?, hh_checked_at = ? WHERE id = ?")
        .run(a.hh_id as string, (a.hh_logo as string) ?? null, (a.hh_site as string) ?? null, (a.hh_about as string) ?? null,
          (a.hh_checked_at as string) ?? null, into);
    }
    db.prepare("DELETE FROM employers WHERE id = ?").run(from);
    logActivity(db, into, "merge", `Склеили с «${employerView(a).name}»`, at);
  });
}

export function addVenue(db: Db, employerId: number, input: Record<string, unknown>, at: string, by: "admin" | "employer") {
  const name = str(input.name, 120);
  if (!name) throw new HttpError(400, "Нужно название заведения");
  const city = str(input.city, 40);
  const row = db.prepare(
    `INSERT INTO venues (key, employer_id, name, city, address, instagram, telegram, website, twogis, added_by, review,
       first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).get(
    `manual:${randomCode()}`, employerId, name, city, str(input.address, 200), handle(input.instagram), handle(input.telegram),
    link(input.website), link(input.twogis), by, by === "employer" ? "pending" : "", at, at,
  ) as { id: number };
  logActivity(db, employerId, "venue", `${by === "employer" ? "Работодатель добавил" : "Добавили"} заведение «${name}»`, at, by);
  return row.id;
}

// ---------- Маршруты ----------

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
  const inner = (req: Request) => {
    if (!same(bearer(req), internal)) throw new HttpError(403, "Нет доступа");
  };
  const db = ctx.db;
  const nowIso = () => new Date(ctx.now()).toISOString();

  async function body(req: Request): Promise<Record<string, unknown>> {
    try {
      const parsed = JSON.parse((await req.bytes(BODY_LIMIT)).toString("utf8") || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
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

  const idParam = (req: Request, name = "id") => {
    const id = Number(req.params[name]);
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "Некорректный id");
    return id;
  };

  const upsertEmployer = db.prepare(
    `INSERT INTO employers (key, name, first_seen, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen RETURNING id`,
  );
  const touchEmployer = db.prepare("UPDATE employers SET last_seen = ? WHERE id = ?");
  const setHh = db.prepare("UPDATE employers SET hh_id = ? WHERE id = ? AND hh_id IS NULL");
  // Работодатель заведения ставится один раз, при первом появлении: потом его меняют только руками
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
  // Вакансия из бота, для которой работодатель выбрал заведение, живёт в нём, а не в заведении по названию
  const chosenVenue = db.prepare(
    "SELECT b.venue_id FROM bot_jobs b JOIN venues v ON v.id = b.venue_id WHERE b.job_id = ? AND v.removed = 0",
  );

  const listQuery = db.prepare(
    `SELECT e.*,
       count(DISTINCT v.id) AS venues,
       group_concat(DISTINCT v.city) AS cities,
       max(v.instagram) AS v_instagram, max(v.telegram) AS v_telegram, max(v.website) AS v_website,
       max(v.avatar) AS avatar,
       sum(v.review = 'pending') AS pending_venues,
       (SELECT count(*) FROM employer_vacancies x JOIN venues y ON y.id = x.venue_id
         WHERE y.employer_id = e.id AND x.active = 1) AS active,
       (SELECT count(*) FROM employer_vacancies x JOIN venues y ON y.id = x.venue_id
         WHERE y.employer_id = e.id) AS total,
       (SELECT max(x.posted_at) FROM employer_vacancies x JOIN venues y ON y.id = x.venue_id
         WHERE y.employer_id = e.id) AS last_posted,
       (SELECT group_concat(DISTINCT x.source) FROM employer_vacancies x JOIN venues y ON y.id = x.venue_id
         WHERE y.employer_id = e.id AND x.active = 1) AS sources,
       (SELECT group_concat(DISTINCT x.category) FROM employer_vacancies x JOIN venues y ON y.id = x.venue_id
         WHERE y.employer_id = e.id) AS categories,
       (SELECT count(*) FROM members m WHERE m.employer_id = e.id AND m.confirmed_at IS NOT NULL) AS members,
       (SELECT count(*) FROM members m WHERE m.employer_id = e.id AND m.confirmed_at IS NULL AND m.rejected_at IS NULL) AS claims,
       (SELECT coalesce(sum(p.amount), 0) FROM payments p WHERE p.employer_id = e.id AND p.status = 'confirmed') AS paid
     FROM employers e LEFT JOIN venues v ON v.employer_id = e.id AND v.removed = 0
     GROUP BY e.id`,
  );

  function card(id: number) {
    const row = getEmployer(db, id);
    if (!row) throw new HttpError(404, "Работодатель не найден");
    const venues = db.prepare("SELECT * FROM venues WHERE employer_id = ? AND removed = 0 ORDER BY review = 'pending' DESC, last_seen DESC, name")
      .all(id) as Record<string, unknown>[];
    const active = db.prepare(
      `SELECT id, title, category, salary, source, posted_at, top_until, first_seen, last_seen, active
       FROM employer_vacancies WHERE venue_id = ? AND active = 1 ORDER BY posted_at DESC`,
    );
    const archive = db.prepare(
      `SELECT id, title, category, salary, source, posted_at, top_until, first_seen, last_seen, active
       FROM employer_vacancies WHERE venue_id = ? AND active = 0 ORDER BY last_seen DESC LIMIT ${ARCHIVE}`,
    );
    const archived = db.prepare("SELECT count(*) AS n FROM employer_vacancies WHERE venue_id = ? AND active = 0");
    const photos = db.prepare("SELECT id, file, width, height FROM media WHERE venue_id = ? ORDER BY id");
    const media = (file: string) => `${ctx.config.apiOrigin}/crm/media/${file}`;
    return {
      employer: employerView(row),
      venues: venues.map((v) => ({
        ...venueView(v),
        vacancies: active.all(v.id as number),
        archive: archive.all(v.id as number),
        archived: (archived.get(v.id as number) as { n: number }).n,
        photos: (photos.all(v.id as number) as { id: number; file: string; width: number; height: number }[])
          .map((p) => ({ id: p.id, url: media(p.file), width: p.width, height: p.height })),
      })),
      members: db.prepare(
        "SELECT id, tg_chat, name, claimed_at, confirmed_at, rejected_at FROM members WHERE employer_id = ? ORDER BY claimed_at",
      ).all(id),
      activities: db.prepare("SELECT id, at, kind, text, by FROM activities WHERE employer_id = ? ORDER BY at DESC, id DESC LIMIT 200")
        .all(id),
      payments: db.prepare("SELECT id, job_id, kind, amount, status, at FROM payments WHERE employer_id = ? ORDER BY at DESC")
        .all(id),
    };
  }

  return [
    // ---------- Часовой сбор ----------

    // Часть снимка: до нескольких сотен работодателей с заведениями и вакансиями, которые сейчас на сайте
    route("POST", "api", "/internal/crm/import", async (req) => {
      inner(req);
      const data = await body(req);
      const at = runAt(data.run_at);
      const employers = (Array.isArray(data.employers) ? data.employers : [])
        .map(cleanEmployer).filter((x): x is EmployerIn => !!x);
      let venues = 0, vacancies = 0;
      tx(db, () => {
        for (const e of employers) {
          // После склейки старое название ведёт к работодателю, в которого склеили
          const aliased = db.prepare("SELECT employer_id FROM employer_aliases WHERE key = ?").get(e.key) as
            { employer_id: number } | undefined;
          const employerId = aliased?.employer_id ?? (upsertEmployer.get(e.key, e.name, at, at) as { id: number }).id;
          if (aliased) touchEmployer.run(at, employerId);
          if (e.hh_id) setHh.run(e.hh_id, employerId);
          for (const v of e.venues) {
            const { id: venueId } = upsertVenue.get(
              v.key, employerId, v.name, v.city ?? null, v.address ?? null, v.lat ?? null, v.lon ?? null,
              v.instagram ?? null, v.telegram ?? null, v.website ?? null, v.avatar ?? null, v.twogis ?? null,
              v.agent_status ?? null, at, at,
            ) as { id: number };
            venues++;
            for (const x of v.vacancies) {
              const job = /^bot-(\d+)$/.exec(x.id);
              const chosen = job ? (chosenVenue.get(Number(job[1])) as { venue_id: number } | undefined) : undefined;
              upsertVacancy.run(x.id, chosen?.venue_id ?? venueId, x.title, x.category ?? null, x.salary ?? null, x.source,
                x.posted_at, x.top_until ?? null, at, at);
              vacancies++;
            }
          }
        }
      });
      return { json: { employers: employers.length, venues, vacancies } };
    }),

    // Снимок целиком дошёл: снятые вакансии в архив; заодно вакансии и оплаты из бота и статусы старой CRM
    route("POST", "api", "/internal/crm/finish", async (req) => {
      inner(req);
      const data = await body(req);
      const at = runAt(data.run_at);
      const archived = db.prepare("UPDATE employer_vacancies SET active = 0 WHERE active = 1 AND last_seen < ?").run(at);
      const jobs = Array.isArray(data.jobs) ? data.jobs : [];
      const payments = Array.isArray(data.payments) ? data.payments : [];
      const marks = data.marks && typeof data.marks === "object" ? (data.marks as Record<string, unknown>) : {};
      const greet: { chat: number; employerId: number }[] = [];
      const ask: number[] = [];
      tx(db, () => {
        for (const raw of jobs) {
          const j = (raw ?? {}) as Record<string, unknown>;
          const jobId = int(j.job_id), chat = int(j.chat);
          if (!jobId || !chat) continue;
          const employerId = resolveEmployer(db, str(j.venue_key, 200), str(j.employer_key, 200));
          db.prepare(
            `INSERT INTO bot_jobs (job_id, tg_chat, employer_id) VALUES (?, ?, ?)
             ON CONFLICT (job_id) DO UPDATE SET employer_id = coalesce(bot_jobs.employer_id, excluded.employer_id)`,
          ).run(jobId, chat, employerId);
          if (employerId === null) continue;
          const name = str(j.name, 120);
          const existing = db.prepare("SELECT confirmed_at FROM members WHERE employer_id = ? AND tg_chat = ?").get(employerId, chat);
          if (!existing) {
            // Новый работодатель, у которого есть только вакансии из бота этого человека: профиль сразу его.
            // Если работодатель уже известен по hh, каналам или у профиля есть хозяин — заявка на проверку
            const owned = db.prepare("SELECT 1 FROM members WHERE employer_id = ? AND confirmed_at IS NOT NULL").get(employerId);
            const foreign = db.prepare(
              `SELECT 1 FROM employer_vacancies x JOIN venues v ON v.id = x.venue_id
               WHERE v.employer_id = ? AND x.source != 'bot' LIMIT 1`,
            ).get(employerId);
            const confirmed = !owned && !foreign;
            db.prepare("INSERT INTO members (employer_id, tg_chat, name, claimed_at, confirmed_at) VALUES (?, ?, ?, ?, ?)")
              .run(employerId, chat, name, at, confirmed ? at : null);
            logActivity(db, employerId, "member",
              confirmed ? `Профиль в боте создан для ${name ?? "работодателя"}` : `${name ?? "Работодатель"} разместил вакансию в боте: ждёт подтверждения профиля`,
              at, "system");
            if (confirmed) greet.push({ chat, employerId });
          }
          ask.push(jobId);
        }
        for (const raw of payments) {
          const p = (raw ?? {}) as Record<string, unknown>;
          const id = int(p.id), jobId = int(p.job_id), amount = int(p.amount);
          const kind = p.kind === "post" ? "post" : "boost";
          const status = ["pending", "confirmed", "rejected"].includes(String(p.status)) ? String(p.status) : "pending";
          const when = str(p.at, 40);
          if (!id || !jobId || amount === null) continue;
          const employerId = (db.prepare("SELECT employer_id FROM bot_jobs WHERE job_id = ?").get(jobId) as { employer_id: number | null } | undefined)
            ?.employer_id ?? resolveEmployer(db, str(p.venue_key, 200), str(p.employer_key, 200));
          const old = db.prepare("SELECT status FROM payments WHERE id = ?").get(id) as { status: string } | undefined;
          db.prepare(
            `INSERT INTO payments (id, job_id, employer_id, kind, amount, status, at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET employer_id = coalesce(payments.employer_id, excluded.employer_id),
               status = excluded.status, amount = excluded.amount`,
          ).run(id, jobId, employerId, kind, amount, status, when ?? at);
          if (employerId !== null && status === "confirmed" && old?.status !== "confirmed") {
            logActivity(db, employerId, "payment", `Оплата ${amount} ₸: ${kind === "post" ? "размещение" : "«Срочно»"}, №${jobId}`, when ?? at, "system");
          }
        }
        for (const [venueKey, raw] of Object.entries(marks)) {
          const m = (raw ?? {}) as Record<string, unknown>;
          const status = STATUSES.includes(String(m.status ?? "") as never) ? String(m.status ?? "") : "";
          const note = str(m.note, 500) ?? "";
          if (!status && !note) continue;
          const employerId = resolveEmployer(db, venueKey, null);
          if (employerId === null) continue;
          const e = getEmployer(db, employerId)!;
          if (e.status || e.note) continue; // уже ведут здесь
          db.prepare("UPDATE employers SET status = ?, note = ? WHERE id = ?").run(status, note, employerId);
          logActivity(db, employerId, "status", `Статус из «CRM заведений»: ${STATUS_LABEL[status]}${note ? `. ${note}` : ""}`,
            str(m.contacted_at, 40) ?? at, "system");
        }
      });
      if (greet.length || ask.length) ctx.background(ctx.crmBot?.afterImport(greet, ask) ?? Promise.resolve());
      const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
      const recheck = new Date(ctx.now() - HH_RECHECK_DAYS * 86_400_000).toISOString();
      const hh = db.prepare(
        "SELECT hh_id FROM employers WHERE hh_id IS NOT NULL AND (hh_checked_at IS NULL OR hh_checked_at < ?) ORDER BY last_seen DESC LIMIT 40",
      ).all(recheck) as { hh_id: string }[];
      return {
        json: {
          archived: Number(archived.changes),
          employers: count("SELECT count(*) AS n FROM employers"),
          venues: count("SELECT count(*) AS n FROM venues WHERE removed = 0"),
          active: count("SELECT count(*) AS n FROM employer_vacancies WHERE active = 1"),
          hh_missing: hh.map((r) => r.hh_id),
        },
      };
    }),

    // Данные компании с открытого API hh: логотип, сайт, описание
    route("POST", "api", "/internal/crm/hh", async (req) => {
      inner(req);
      const data = await body(req);
      const at = nowIso();
      const update = db.prepare("UPDATE employers SET hh_logo = ?, hh_site = ?, hh_about = ?, hh_checked_at = ? WHERE hh_id = ?");
      let updated = 0;
      tx(db, () => {
        for (const raw of Array.isArray(data.employers) ? data.employers : []) {
          const h = (raw ?? {}) as Record<string, unknown>;
          const id = str(h.id, 20);
          if (!id || !/^\d+$/.test(id)) continue;
          updated += Number(update.run(link(h.logo), link(h.site), str(h.about, 2000), at, id).changes);
        }
      });
      return { json: { updated } };
    }),

    // ---------- Админка ----------

    route("GET", "api", "/admin/crm", (req) => {
      admin(req);
      const split = (s: unknown) => (typeof s === "string" && s ? s.split(",") : []);
      const rows = (listQuery.all() as Record<string, unknown>[]).map((r) => {
        const e = employerView(r);
        return {
          id: e.id, name: e.name, status: e.status, next_at: e.next_at, note: e.note,
          first_seen: e.first_seen, last_seen: e.last_seen,
          venues: r.venues, cities: split(r.cities), sources: split(r.sources), categories: split(r.categories),
          instagram: e.instagram ?? r.v_instagram ?? null, telegram: e.telegram ?? r.v_telegram ?? null,
          website: e.website ?? r.v_website ?? e.hh?.site ?? null,
          avatar: r.avatar ?? null, logo: e.hh?.logo ?? null,
          active: r.active, total: r.total, last_posted: r.last_posted,
          members: r.members, claims: r.claims, pending_venues: r.pending_venues ?? 0, paid: r.paid,
        };
      });
      return { headers: { "Cache-Control": "no-store" }, json: { employers: rows } };
    }),

    route("GET", "api", "/admin/crm/:id", (req) => {
      admin(req);
      return { headers: { "Cache-Control": "no-store" }, json: card(idParam(req)) };
    }),

    // Правка работодателя: поля карточки (пустая строка возвращает собранное), статус, следующий шаг, заметка
    route("PATCH", "api", "/admin/crm/:id", async (req) => {
      admin(req);
      const id = idParam(req);
      const row = getEmployer(db, id);
      if (!row) throw new HttpError(404, "Работодатель не найден");
      const data = await body(req);
      const at = nowIso();
      const edits = parse(row.edits);
      for (const f of EMPLOYER_FIELDS) {
        if (!(f in data)) continue;
        const raw = data[f];
        let value: string | null;
        if (f === "website") value = link(raw);
        else if (f === "instagram" || f === "telegram") value = handle(raw);
        else if (f === "bin") value = str(raw, 12) && /^\d{12}$/.test(String(raw).trim()) ? String(raw).trim() : null;
        else value = str(raw, f === "about" ? 2000 : 200);
        if (raw !== "" && raw !== null && value === null) throw new HttpError(400, `Не похоже на ${f}`);
        if (value === null) delete edits[f];
        else edits[f] = value;
      }
      tx(db, () => {
        db.prepare("UPDATE employers SET edits = ? WHERE id = ?").run(JSON.stringify(edits), id);
        if ("status" in data) {
          const status = String(data.status ?? "");
          if (!STATUSES.includes(status as never)) throw new HttpError(400, "Неизвестный статус");
          if (status !== row.status) {
            db.prepare("UPDATE employers SET status = ? WHERE id = ?").run(status, id);
            logActivity(db, id, "status", `Статус: ${STATUS_LABEL[status]}`, at);
          }
        }
        if ("next_at" in data) {
          const next = data.next_at ? String(data.next_at) : null;
          if (next !== null && !/^\d{4}-\d{2}-\d{2}$/.test(next)) throw new HttpError(400, "Дата шага в виде ГГГГ-ММ-ДД");
          db.prepare("UPDATE employers SET next_at = ? WHERE id = ?").run(next, id);
        }
        if ("note" in data) db.prepare("UPDATE employers SET note = ? WHERE id = ?").run(str(data.note, 1000) ?? "", id);
      });
      return { json: card(id) };
    }),

    route("POST", "api", "/admin/crm/:id/activities", async (req) => {
      admin(req);
      const id = idParam(req);
      if (!getEmployer(db, id)) throw new HttpError(404, "Работодатель не найден");
      const data = await body(req);
      const kind = ["note", "call", "message"].includes(String(data.kind)) ? String(data.kind) : "note";
      const text = str(data.text, 1000);
      if (!text) throw new HttpError(400, "Пустая запись");
      logActivity(db, id, kind, text, nowIso());
      return { json: card(id) };
    }),

    route("POST", "api", "/admin/crm/:id/merge", async (req) => {
      admin(req);
      const id = idParam(req);
      const into = int((await body(req)).into);
      if (!into) throw new HttpError(400, "Нужен работодатель, в которого склеиваем");
      mergeEmployers(db, id, into, nowIso());
      return { json: card(into) };
    }),

    route("POST", "api", "/admin/crm/:id/venues", async (req) => {
      admin(req);
      const id = idParam(req);
      if (!getEmployer(db, id)) throw new HttpError(404, "Работодатель не найден");
      addVenue(db, id, await body(req), nowIso(), "admin");
      return { json: card(id) };
    }),

    // Правка заведения: поля, перенос к другому работодателю, решение по заведению от работодателя, удаление
    route("PATCH", "api", "/admin/crm/venues/:vid", async (req) => {
      admin(req);
      const vid = idParam(req, "vid");
      const row = db.prepare("SELECT * FROM venues WHERE id = ?").get(vid) as Record<string, unknown> | undefined;
      if (!row) throw new HttpError(404, "Заведение не найдено");
      const data = await body(req);
      const at = nowIso();
      const edits = parse(row.edits);
      const manual = String(row.key).startsWith("manual:");
      for (const f of VENUE_FIELDS) {
        if (!(f in data)) continue;
        const raw = data[f];
        let value: string | null;
        if (f === "website" || f === "twogis") value = link(raw);
        else if (f === "instagram" || f === "telegram") value = handle(raw);
        else value = str(raw, 200);
        if (raw !== "" && raw !== null && value === null) throw new HttpError(400, `Не похоже на ${f}`);
        // У добавленного руками заведения поля свои, у собранного — правка поверх
        if (manual) db.prepare(`UPDATE venues SET ${f} = ? WHERE id = ?`).run(f === "name" ? value ?? row.name as string : value, vid);
        else if (value === null) delete edits[f];
        else edits[f] = value;
      }
      let employerId = row.employer_id as number;
      tx(db, () => {
        if (!manual) db.prepare("UPDATE venues SET edits = ? WHERE id = ?").run(JSON.stringify(edits), vid);
        if ("employer_id" in data) {
          const to = int(data.employer_id);
          if (!to || !getEmployer(db, to)) throw new HttpError(400, "Нет такого работодателя");
          if (to !== employerId) {
            db.prepare("UPDATE venues SET employer_id = ? WHERE id = ?").run(to, vid);
            logActivity(db, employerId, "venue", `Заведение «${venueView(row).name}» перенесли к «${employerView(getEmployer(db, to)!).name}»`, at);
            logActivity(db, to, "venue", `Перенесли заведение «${venueView(row).name}»`, at);
            employerId = to;
          }
        }
        if ("review" in data) {
          const review = data.review === "approved" ? "" : data.review === "rejected" ? "rejected" : null;
          if (review === null) throw new HttpError(400, "review: approved или rejected");
          db.prepare("UPDATE venues SET review = ? WHERE id = ?").run(review, vid);
          logActivity(db, employerId, "venue", `Заведение «${venueView(row).name}» ${review ? "отклонено" : "одобрено"}`, at);
          if (row.added_by === "employer") ctx.background(ctx.crmBot?.venueReviewed(vid, !review) ?? Promise.resolve());
        }
        if (data.removed === true) {
          db.prepare("UPDATE venues SET removed = 1 WHERE id = ?").run(vid);
          logActivity(db, employerId, "venue", `Убрали заведение «${venueView(row).name}»`, at);
        }
      });
      return { json: card(employerId) };
    }),

    // Фото заведения: админка уменьшает снимок в браузере и присылает JPEG, сервер вычищает метаданные
    route("PUT", "api", "/admin/crm/venues/:vid/photo", async (req) => {
      admin(req);
      const vid = idParam(req, "vid");
      const row = db.prepare("SELECT employer_id, name FROM venues WHERE id = ?").get(vid) as { employer_id: number; name: string } | undefined;
      if (!row) throw new HttpError(404, "Заведение не найдено");
      if ((db.prepare("SELECT count(*) AS n FROM media WHERE venue_id = ?").get(vid) as { n: number }).n >= MAX_PHOTOS) {
        throw new HttpError(409, `Не больше ${MAX_PHOTOS} фото на заведение`);
      }
      const photo = cleanJpeg(await req.bytes(MAX_PHOTO_BYTES));
      if (!photo) throw new HttpError(400, "Нужно фото JPEG от 100 до 2560 точек по стороне");
      const dir = ctx.config.videosDir;
      const file = `crm-${randomCode()}${randomCode()}.jpg`;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeAtomic(join(dir, file), photo.data);
      db.prepare("INSERT INTO media (venue_id, file, width, height, at) VALUES (?, ?, ?, ?, ?)")
        .run(vid, file, photo.width, photo.height, nowIso());
      return { json: card(row.employer_id) };
    }),

    route("DELETE", "api", "/admin/crm/media/:mid", (req) => {
      admin(req);
      const mid = idParam(req, "mid");
      const row = db.prepare("SELECT m.file, v.employer_id FROM media m JOIN venues v ON v.id = m.venue_id WHERE m.id = ?")
        .get(mid) as { file: string; employer_id: number } | undefined;
      if (!row) throw new HttpError(404, "Фото не найдено");
      db.prepare("DELETE FROM media WHERE id = ?").run(mid);
      removeFiles(ctx.config.videosDir, [row.file]);
      return { json: card(row.employer_id) };
    }),

    // Заявка «Это моя компания»: подтвердить или отклонить
    route("POST", "api", "/admin/crm/members/:mid", async (req) => {
      admin(req);
      const mid = idParam(req, "mid");
      const m = db.prepare("SELECT * FROM members WHERE id = ?").get(mid) as Record<string, unknown> | undefined;
      if (!m) throw new HttpError(404, "Заявка не найдена");
      const action = String((await body(req)).action);
      const at = nowIso();
      if (action === "confirm") {
        db.prepare("UPDATE members SET confirmed_at = ?, rejected_at = NULL WHERE id = ?").run(at, mid);
        logActivity(db, m.employer_id as number, "member", `Профиль в боте подтверждён: ${m.name ?? m.tg_chat}`, at);
      } else if (action === "reject") {
        db.prepare("UPDATE members SET rejected_at = ?, confirmed_at = NULL WHERE id = ?").run(at, mid);
        logActivity(db, m.employer_id as number, "member", `Заявка отклонена: ${m.name ?? m.tg_chat}`, at);
      } else throw new HttpError(400, "action: confirm или reject");
      ctx.background(ctx.crmBot?.memberDecided(mid, action === "confirm") ?? Promise.resolve());
      return { json: card(m.employer_id as number) };
    }),

    // Фото заведений открыты по ссылке: имя файла случайное
    route("GET", "api", "/crm/media/:file", (req) => {
      const file = req.params.file ?? "";
      if (!/^crm-[A-Za-z0-9]+\.jpg$/.test(file) || !db.prepare("SELECT 1 FROM media WHERE file = ?").get(file)) {
        throw new HttpError(404, "Нет фото");
      }
      const reply = fileReply(req, join(ctx.config.videosDir, file), "image/jpeg");
      return { ...reply, headers: { ...reply.headers, "Cache-Control": "public, max-age=86400" } };
    }),
  ];
}

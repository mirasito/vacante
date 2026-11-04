// Отклики соискателя: короткая копия вакансии, способ отклика, стадия с историей и своя ссылка на профиль.
// Стадию меняют сам соискатель (в приложении), работодатель (открыл ссылку, ответил на странице профиля)
// и система. Каждая смена записывается в историю с тем, кто её сделал.
import { tx, type Db } from "./db.ts";
import { HttpError } from "./http.ts";
import type { Lang } from "./labels.ts";
import { CITIES, type Profile } from "./profile.ts";
import { applicationLink, iso } from "./seekers.ts";
import { weekStart } from "./time.ts";

export const STAGES = [
  "liked", "sent", "seen", "invited", "interview", "offer", "hired", "rejected", "no_answer", "not_interested",
] as const;
export type Stage = (typeof STAGES)[number];
export const METHODS = ["whatsapp", "telegram", "call", "hh", "bot", "post"] as const;
export type Method = (typeof METHODS)[number];
export const CONTACT_KINDS = ["whatsapp", "phone", "telegram"] as const;
export type By = "seeker" | "employer" | "system";

/** Три выхода из любой стадии: дальше такой отклик в поиске не участвует. */
export const CLOSED: readonly Stage[] = ["rejected", "no_answer", "not_interested"];
/** До этих стадий отклик ещё ждёт ответа: просмотр и ответ работодателя двигают его вперёд. */
const WAITING: readonly Stage[] = ["liked", "sent", "seen", "invited"];
/** Сколько откликов может быть у одного человека: защита базы от мусора. */
export const MAX_APPLICATIONS = 1000;
/** Сколько лайков можно перенести с телефона за раз. */
export const MAX_IMPORT = 300;
export const VACANCY_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

export interface VacancyCopy {
  id: string;
  title: string;
  title_kk: string | null;
  employer: string | null;
  city: string | null;
  address: string | null;
  map: string | null;
  url: string | null;
  source_url: string | null;
  contact: string[];
}

export interface ApplicationRow {
  id: number;
  seeker_id: number;
  vacancy_id: string;
  title: string;
  title_kk: string | null;
  employer: string | null;
  city: string | null;
  address: string | null;
  map: string | null;
  url: string | null;
  source_url: string | null;
  contact: string;
  method: Method | null;
  stage: Stage;
  interview_at: string | null;
  start_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

const bad = (message: string) => new HttpError(400, message);

function clean(value: unknown, field: string, max: number, required = false): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw bad(`Не заполнено поле ${field}`);
    return null;
  }
  if (typeof value !== "string") throw bad(`Поле ${field} должно быть строкой`);
  const text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").trim();
  if (!text) {
    if (required) throw bad(`Не заполнено поле ${field}`);
    return null;
  }
  return text.slice(0, max);
}

function httpsUrl(value: unknown, field: string): string | null {
  const url = clean(value, field, 300);
  if (url === null) return null;
  if (!/^https:\/\/[^\s"'<>]+$/.test(url)) throw bad(`Поле ${field}: нужен адрес https://…`);
  return url;
}

/** Копия вакансии из приложения: то же, что в открытых данных сайта, без номеров и переписки. */
export function parseVacancy(body: unknown): VacancyCopy {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("Нужна вакансия");
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string" || !VACANCY_ID.test(b.id)) throw bad("Поле id: номер вакансии с сайта");
  const city = typeof b.city === "string" && (CITIES as readonly string[]).includes(b.city) ? b.city : null;
  const contact = Array.isArray(b.contact)
    ? CONTACT_KINDS.filter((kind) => (b.contact as unknown[]).includes(kind))
    : [];
  return {
    id: b.id,
    title: clean(b.title, "title", 120, true) as string,
    title_kk: clean(b.title_kk, "title_kk", 120),
    employer: clean(b.employer, "employer", 120),
    city,
    address: clean(b.address, "address", 200),
    map: httpsUrl(b.map, "map"),
    url: httpsUrl(b.url, "url"),
    source_url: httpsUrl(b.source_url, "source_url"),
    contact,
  };
}

export interface Patch {
  stage?: Stage;
  method?: Method | null;
  interview_at?: string | null;
  start_at?: string | null;
  note?: string | null;
}

const isoOrNull = (value: unknown, field: string, now: number): string | null => {
  if (value === null) return null;
  if (typeof value !== "string") throw bad(`Поле ${field}: дата и время`);
  const ms = Date.parse(value);
  // Собеседование не раньше месяца назад и не дальше полугода вперёд
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(ms)) throw bad(`Поле ${field}: дата и время`);
  if (ms < now - 30 * 86_400_000 || ms > now + 183 * 86_400_000) throw bad(`Поле ${field}: проверьте дату`);
  return iso(ms);
};

/** Что соискатель меняет в отклике. Стадию «Просмотрен» ставит только открытие ссылки. */
export function parsePatch(body: unknown, now: number): Patch {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("Нужны изменения");
  const b = body as Record<string, unknown>;
  const patch: Patch = {};
  if (b.stage !== undefined) {
    if (typeof b.stage !== "string" || !(STAGES as readonly string[]).includes(b.stage) || b.stage === "seen") {
      throw bad("Поле stage: стадия отклика");
    }
    patch.stage = b.stage as Stage;
  }
  if (b.method !== undefined) {
    if (b.method !== null && !(METHODS as readonly unknown[]).includes(b.method)) throw bad("Поле method: способ отклика");
    patch.method = b.method as Method | null;
  }
  if (b.interview_at !== undefined) patch.interview_at = isoOrNull(b.interview_at, "interview_at", now);
  if (b.start_at !== undefined) {
    if (b.start_at !== null && (typeof b.start_at !== "string" || !isDay(b.start_at))) {
      throw bad("Поле start_at: день ГГГГ-ММ-ДД");
    }
    patch.start_at = b.start_at as string | null;
  }
  if (b.note !== undefined) patch.note = clean(b.note, "note", 500);
  return patch;
}

const isDay = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

function addEvent(db: Db, applicationId: number, stage: Stage, by: By, at: string) {
  db.prepare("INSERT INTO application_events (application_id, stage, by, at) VALUES (?, ?, ?, ?)").run(
    applicationId, stage, by, at,
  );
}

export function getApplication(db: Db, seekerId: number, id: number): ApplicationRow | undefined {
  return db.prepare("SELECT * FROM applications WHERE id = ? AND seeker_id = ?").get(id, seekerId) as
    | ApplicationRow
    | undefined;
}

export function applicationByVacancy(db: Db, seekerId: number, vacancyId: string): ApplicationRow | undefined {
  return db.prepare("SELECT * FROM applications WHERE seeker_id = ? AND vacancy_id = ?").get(seekerId, vacancyId) as
    | ApplicationRow
    | undefined;
}

function insert(db: Db, seekerId: number, v: VacancyCopy, createdAt: string): number {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM applications WHERE seeker_id = ?").get(seekerId) as { n: number };
  if (Number(n) >= MAX_APPLICATIONS) throw new HttpError(409, `Не больше ${MAX_APPLICATIONS} откликов: удалите старые`);
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO applications (seeker_id, vacancy_id, title, title_kk, employer, city, address, map, url, source_url,
         contact, stage, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'liked', ?, ?)`,
    )
    .run(
      seekerId, v.id, v.title, v.title_kk, v.employer, v.city, v.address, v.map, v.url, v.source_url,
      JSON.stringify(v.contact), createdAt, createdAt,
    );
  const id = Number(lastInsertRowid);
  addEvent(db, id, "liked", "seeker", createdAt);
  return id;
}

/** Отклик на вакансию: новый со стадией «Нравится» или уже существующий. */
export function upsertApplication(db: Db, seekerId: number, v: VacancyCopy, now: number): { id: number; created: boolean } {
  return tx(db, () => {
    const existing = applicationByVacancy(db, seekerId, v.id);
    if (existing) {
      // Пока человек не откликнулся, копия вакансии обновляется: в ленте могли поправить название
      if (existing.stage === "liked") {
        db.prepare(
          `UPDATE applications SET title = ?, title_kk = ?, employer = ?, city = COALESCE(?, city), address = ?, map = ?,
             url = ?, source_url = ?, contact = ? WHERE id = ?`,
        ).run(
          v.title, v.title_kk, v.employer, v.city, v.address, v.map, v.url, v.source_url, JSON.stringify(v.contact),
          existing.id,
        );
      }
      return { id: existing.id, created: false };
    }
    return { id: insert(db, seekerId, v, iso(now)), created: true };
  });
}

export interface ImportItem {
  vacancy: VacancyCopy;
  liked_at: string;
  sent_at: string | null;
  /** Что человек отметил на телефоне: стадия, способ, дата собеседования, день выхода, заметка. */
  patch: Patch;
}

/**
 * Лайки и отклики, сделанные на телефоне до профиля. Перенос не должен застревать из-за одной
 * старой записи: вакансия с ошибкой пропускается, а неверная отметка (стадия, дата) не переносится.
 */
export function parseImport(body: unknown, now: number): ImportItem[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw bad("Нужен список items");
  if (items.length > MAX_IMPORT) throw bad(`Не больше ${MAX_IMPORT} за раз`);
  const at = (value: unknown, fallback: string) => {
    const ms = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isNaN(ms) || ms > now || ms < now - 365 * 86_400_000 ? fallback : iso(ms);
  };
  const parsed: ImportItem[] = [];
  for (const raw of items) {
    const item = (raw ?? {}) as Record<string, unknown>;
    let vacancy: VacancyCopy;
    try {
      vacancy = parseVacancy(item.vacancy);
    } catch {
      continue;
    }
    const { stage, method, interview_at, start_at, note } = item;
    let patch: Patch;
    try {
      patch = parsePatch({ stage, method, interview_at, start_at, note }, now);
    } catch {
      patch = {};
    }
    if (patch.stage === "liked") delete patch.stage;
    const liked = at(item.liked_at, iso(now));
    const sent = patch.stage && !CLOSED.includes(patch.stage) ? at(item.sent_at, liked) : null;
    parsed.push({ vacancy, liked_at: liked, sent_at: sent && sent < liked ? liked : sent, patch });
  }
  return parsed;
}

/** Переносит отклики с телефона. Уже известные вакансии пропускаются. Возвращает, сколько добавлено. */
export function importApplications(db: Db, seekerId: number, items: ImportItem[], now: number): number {
  return tx(db, () => {
    let added = 0;
    for (const item of items) {
      if (applicationByVacancy(db, seekerId, item.vacancy.id)) continue;
      const id = insert(db, seekerId, item.vacancy, item.liked_at);
      const { stage, method = null, interview_at = null, start_at = null, note = null } = item.patch;
      const updated = item.sent_at ?? (stage ? iso(now) : item.liked_at);
      db.prepare(
        `UPDATE applications SET stage = ?, method = ?, interview_at = ?, start_at = ?, note = ?, sent_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(stage ?? "liked", method, interview_at, start_at, note, item.sent_at, updated, id);
      if (item.sent_at) addEvent(db, id, "sent", "seeker", item.sent_at);
      if (stage && stage !== "sent") addEvent(db, id, stage, "seeker", iso(now));
      added++;
    }
    return added;
  });
}

/**
 * Меняет отклик и записывает смену стадии в историю. Дата собеседования сама переводит отклик
 * в «Собеседование», если он ещё ждал ответа. Возвращает обновлённую строку или undefined, если отклика нет.
 */
export function patchApplication(
  db: Db,
  seekerId: number,
  id: number,
  patch: Patch,
  by: By,
  now: number,
): ApplicationRow | undefined {
  return tx(db, () => {
    const row = getApplication(db, seekerId, id);
    if (!row) return undefined;
    const at = iso(now);
    let stage = patch.stage ?? row.stage;
    if (patch.interview_at && patch.stage === undefined && WAITING.includes(stage)) stage = "interview";
    const next: ApplicationRow = {
      ...row,
      stage,
      method: patch.method !== undefined ? patch.method : row.method,
      interview_at: patch.interview_at !== undefined ? patch.interview_at : row.interview_at,
      start_at: patch.start_at !== undefined ? patch.start_at : row.start_at,
      note: patch.note !== undefined ? patch.note : row.note,
      // Любая стадия после «Нравится» значит, что человек откликнулся
      sent_at: row.sent_at ?? (stage !== "liked" && !CLOSED.includes(stage) ? at : null),
      updated_at: at,
    };
    db.prepare(
      `UPDATE applications SET stage = ?, method = ?, interview_at = ?, start_at = ?, note = ?, sent_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(next.stage, next.method, next.interview_at, next.start_at, next.note, next.sent_at, next.updated_at, id);
    if (next.stage !== row.stage) addEvent(db, id, next.stage, by, at);
    return next;
  });
}

/** Работодатель открыл ссылку отклика: «Просмотрен», если отклик ещё ждал этого. true, если стадия сменилась. */
export function markSeen(db: Db, applicationId: number, now: number): boolean {
  return tx(db, () => {
    const row = db.prepare("SELECT stage FROM applications WHERE id = ?").get(applicationId) as { stage: Stage } | undefined;
    if (!row || (row.stage !== "liked" && row.stage !== "sent")) return false;
    const at = iso(now);
    db.prepare("UPDATE applications SET stage = 'seen', sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?").run(
      at, at, applicationId,
    );
    addEvent(db, applicationId, "seen", "employer", at);
    return true;
  });
}

/** Ответ работодателя кнопкой на странице профиля: приглашение (можно со временем) или «Не подходит». */
export type Answer = { kind: "invite"; at: string | null } | { kind: "reject" };

/** На какие отклики работодатель ещё может ответить со страницы профиля. */
export const answerable = (stage: Stage) => !["offer", "hired", "not_interested"].includes(stage);

/**
 * Ответ работодателя. Возвращает отклик после ответа, если ответ что-то поменял (повторное нажатие
 * той же кнопки кандидату второй раз не пишет), иначе undefined.
 */
export function employerAnswer(
  db: Db,
  seekerId: number,
  applicationId: number,
  answer: Answer,
  now: number,
): ApplicationRow | undefined {
  const row = getApplication(db, seekerId, applicationId);
  if (!row || !answerable(row.stage)) return undefined;
  // Приглашение без времени не отменяет собеседование, которое кандидат уже записал себе
  const patch: Patch =
    answer.kind === "reject"
      ? { stage: "rejected" }
      : answer.at
        ? { stage: "interview", interview_at: answer.at }
        : { stage: row.stage === "interview" ? "interview" : "invited" };
  const next = patchApplication(db, seekerId, row.id, patch, "employer", now);
  return next && (next.stage !== row.stage || next.interview_at !== row.interview_at) ? next : undefined;
}

/** Последний ответ работодателя со страницы профиля, чтобы показать его там же. */
export function lastEmployerAnswer(db: Db, applicationId: number): { stage: Stage; at: string } | undefined {
  return db
    .prepare(
      `SELECT stage, at FROM application_events WHERE application_id = ? AND by = 'employer' AND stage != 'seen'
       ORDER BY at DESC, id DESC LIMIT 1`,
    )
    .get(applicationId) as { stage: Stage; at: string } | undefined;
}

export function deleteApplication(db: Db, seekerId: number, id: number): boolean {
  return tx(db, () => {
    // Ссылка отклика перестаёт открываться вместе с ним
    db.prepare("DELETE FROM links WHERE application_id = ? AND seeker_id = ?").run(id, seekerId);
    const { changes } = db.prepare("DELETE FROM applications WHERE id = ? AND seeker_id = ?").run(id, seekerId);
    return Number(changes) > 0;
  });
}

/** Ссылка отклика: работающая или новая, если её ещё не было или срок вышел. */
export function ensureLink(db: Db, seekerId: number, applicationId: number, now: number): string {
  const link = db
    .prepare(
      `SELECT code FROM links WHERE application_id = ? AND seeker_id = ? AND active = 1
         AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 1`,
    )
    .get(applicationId, seekerId, iso(now)) as { code: string } | undefined;
  return link?.code ?? applicationLink(db, seekerId, applicationId, now);
}

export interface ApplicationView {
  id: number;
  vacancy: VacancyCopy;
  method: Method | null;
  stage: Stage;
  interview_at: string | null;
  start_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  /** Когда работодатель впервые открыл ссылку отклика, и сколько раз открывал. */
  seen_at: string | null;
  views: number;
  link: { code: string; url: string } | null;
  events?: { stage: Stage; by: By; at: string }[];
}

type ListRow = ApplicationRow & { seen_at: string | null; views: number; link_code: string | null };

const LIST_SQL = `SELECT a.*,
    (SELECT MIN(at) FROM views v WHERE v.application_id = a.id) AS seen_at,
    (SELECT COUNT(*) FROM views v WHERE v.application_id = a.id) AS views,
    (SELECT code FROM links l WHERE l.application_id = a.id AND l.active = 1 AND (l.expires_at IS NULL OR l.expires_at > ?)
       ORDER BY l.created_at DESC LIMIT 1) AS link_code
  FROM applications a`;

function toView(row: ListRow, profileOrigin: string): ApplicationView {
  let contact: string[] = [];
  try {
    contact = JSON.parse(row.contact) as string[];
  } catch {
    contact = [];
  }
  return {
    id: row.id,
    vacancy: {
      id: row.vacancy_id,
      title: row.title,
      title_kk: row.title_kk,
      employer: row.employer,
      city: row.city,
      address: row.address,
      map: row.map,
      url: row.url,
      source_url: row.source_url,
      contact,
    },
    method: row.method,
    stage: row.stage,
    interview_at: row.interview_at,
    start_at: row.start_at,
    note: row.note,
    created_at: row.created_at,
    updated_at: row.updated_at,
    sent_at: row.sent_at,
    seen_at: row.seen_at,
    views: Number(row.views),
    link: row.link_code ? { code: row.link_code, url: `${profileOrigin}/${row.link_code}` } : null,
  };
}

export function listApplications(db: Db, seekerId: number, profileOrigin: string, now: number): ApplicationView[] {
  const rows = db
    .prepare(`${LIST_SQL} WHERE a.seeker_id = ? ORDER BY a.updated_at DESC, a.id DESC`)
    .all(iso(now), seekerId) as unknown as ListRow[];
  return rows.map((row) => toView(row, profileOrigin));
}

export function applicationView(
  db: Db,
  seekerId: number,
  id: number,
  profileOrigin: string,
  now: number,
): ApplicationView | null {
  const row = db.prepare(`${LIST_SQL} WHERE a.id = ? AND a.seeker_id = ?`).get(iso(now), id, seekerId) as unknown as
    | ListRow
    | undefined;
  if (!row) return null;
  const events = db
    .prepare("SELECT stage, by, at FROM application_events WHERE application_id = ? ORDER BY at, id")
    .all(id) as unknown as { stage: Stage; by: By; at: string }[];
  return { ...toView(row, profileOrigin), events };
}

/** Общая стадия поиска по самому дальнему живому отклику: Смотрю, Откликаюсь, Собеседования, Выбираю, Работаю. */
export const SEARCH_STAGES = ["looking", "applying", "interviews", "choosing", "working"] as const;
export type SearchStage = (typeof SEARCH_STAGES)[number];
const SEARCH_OF: Record<Stage, number> = {
  liked: 0, sent: 1, seen: 1, invited: 2, interview: 2, offer: 3, hired: 4, rejected: 0, no_answer: 0, not_interested: 0,
};

export interface Summary {
  stage: SearchStage;
  /** Эта неделя с понедельника: сколько откликов отправлено, сколько из откликов открыли, сколько пригласили. */
  week: { from: string; sent: number; seen: number; invited: number };
  /** Ближайшее собеседование (или идущее сейчас). */
  next_interview: { id: number; at: string; title: string; employer: string | null; address: string | null } | null;
  counts: Record<Stage, number>;
}

export function summary(db: Db, seekerId: number, now: number): Summary {
  const rows = db
    .prepare("SELECT id, stage, sent_at, interview_at, title, employer, address FROM applications WHERE seeker_id = ?")
    .all(seekerId) as unknown as Pick<ApplicationRow, "id" | "stage" | "sent_at" | "interview_at" | "title" | "employer" | "address">[];
  const from = iso(weekStart(now));
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  let furthest = 0;
  for (const r of rows) {
    counts[r.stage]++;
    if (!CLOSED.includes(r.stage)) furthest = Math.max(furthest, SEARCH_OF[r.stage]);
  }
  const one = (sql: string) => Number((db.prepare(sql).get(seekerId, from) as { n: number }).n);
  const seen = one(
    `SELECT COUNT(DISTINCT v.application_id) AS n FROM views v JOIN applications a ON a.id = v.application_id
     WHERE a.seeker_id = ? AND v.at >= ?`,
  );
  const invited = one(
    `SELECT COUNT(DISTINCT e.application_id) AS n FROM application_events e JOIN applications a ON a.id = e.application_id
     WHERE a.seeker_id = ? AND e.at >= ? AND e.stage IN ('invited', 'interview', 'offer')`,
  );
  // Собеседование, которое идёт прямо сейчас, ещё показываем: два часа после начала
  const soon = rows
    .filter((r) => r.stage === "interview" && r.interview_at && Date.parse(r.interview_at) > now - 2 * 3_600_000)
    .sort((a, b) => (a.interview_at! < b.interview_at! ? -1 : 1))[0];
  return {
    stage: SEARCH_STAGES[furthest] ?? "looking",
    week: { from, sent: rows.filter((r) => r.sent_at && r.sent_at >= from).length, seen, invited },
    next_interview: soon
      ? { id: soon.id, at: soon.interview_at!, title: soon.title, employer: soon.employer, address: soon.address }
      : null,
    counts,
  };
}

const EXPERIENCE_TEXT: Record<Lang, Record<Profile["experience"], string>> = {
  ru: {
    none: "Опыта пока нет, но быстро учусь.",
    lt1: "Опыт до года.",
    "1to3": "Опыт 1–3 года.",
    gt3: "Опыт больше 3 лет.",
  },
  kk: {
    none: "Тәжірибем әлі жоқ, бірақ тез үйренемін.",
    lt1: "Тәжірибем бір жылға дейін.",
    "1to3": "Тәжірибем 1–3 жыл.",
    gt3: "Тәжірибем 3 жылдан артық.",
  },
};

const START_TEXT: Record<Lang, Record<Profile["start"], string>> = {
  ru: {
    today: "Могу выйти сегодня.",
    week: "Могу выйти на этой неделе.",
    "2weeks": "Могу выйти через 1–2 недели.",
    later: "Могу выйти позже, обсудим.",
  },
  kk: {
    today: "Бүгін шыға аламын.",
    week: "Осы аптада шыға аламын.",
    "2weeks": "1–2 аптадан кейін шыға аламын.",
    later: "Кейінірек шыға аламын.",
  },
};

/**
 * Готовый текст отклика из профиля: его человек видит и может поправить до отправки.
 * Строка со ссылкой отдельно: в приложении её выключают переключателем.
 */
export function applicationText(
  p: Profile,
  title: string,
  linkUrl: string,
  hasVideo: boolean,
  lang: Lang,
): { text: string; link_text: string } {
  const greeting =
    lang === "kk"
      ? `Сәлеметсіз бе! «${title}» бос орны бойынша жазып отырмын. Менің атым ${p.name}.`
      : `Здравствуйте! Пишу по вакансии «${title}». Меня зовут ${p.name}.`;
  const text = [greeting, EXPERIENCE_TEXT[lang][p.experience], START_TEXT[lang][p.start]].join(" ");
  const label =
    lang === "kk" ? (hasVideo ? "Бейнесі бар профилім" : "Профилім") : hasVideo ? "Мой профиль с видео" : "Мой профиль";
  return { text, link_text: `${label}: ${linkUrl}` };
}

// Анкета соискателя: что можно заполнить, проверка того, что прислало приложение, и сила профиля.
import { HOME_SOURCES, inKazakhstan, roundHome, type HomeSource } from "./geo.ts";
import { HttpError } from "./http.ts";

/** Версия текста согласия. Меняется вместе с текстом в приложении (app/src/profile/texts.ts, CONSENT). */
export const CONSENT_VERSION = "2026-11-16.1";
/** С какими версиями текста можно создать профиль: нынешняя и прежняя, пока у людей открыто старое приложение. */
export const CONSENT_VERSIONS: readonly string[] = [CONSENT_VERSION, "2026-11-04.2"];

// Те же города, что у сбора вакансий (vacante/parse.py, CITIES); совпадение проверяет tests/test_server_lists.py
export const CITIES = [
  "almaty", "astana", "shymkent", "karaganda", "aktobe", "atyrau", "aktau", "pavlodar", "ust-kamenogorsk",
  "semey", "kostanay", "uralsk", "taraz", "turkestan", "petropavlovsk", "kyzylorda", "kokshetau", "taldykorgan",
] as const;
export const EXPERIENCE = ["none", "lt1", "1to3", "gt3"] as const;
export const EMPLOYMENT = ["full", "shifts", "night", "flexible", "part", "weekends", "rotation"] as const;
export const START = ["today", "week", "2weeks", "later"] as const;
export const PAY_PERIOD = ["month", "shift"] as const;
export const LANGUAGES = ["kk", "ru", "en"] as const;
export const MAX_ROLES = 3;
/** Санкнижка: есть действующая, оформлю, нет. */
export const MED = ["yes", "soon", "no"] as const;
/** Сколько человек проработал на прошлом месте. */
export const JOB_TERM = ["lt6m", "6to12", "1to3", "gt3"] as const;
export const MAX_JOBS = 3;
export const MAX_SKILLS = 12;
/** Сколько дней горит «Ищу работу сейчас» после последнего подтверждения. */
export const LOOKING_DAYS = 30;
// Навыки кнопками. Какие из них показать, приложение решает по профессиям человека
// (app/src/profile/skills.ts); подписи для страницы профиля — в labels.ts. Списки сверяет tests/test_server_lists.py
export const SKILLS = [
  "hot", "cold", "prep", "sushi", "pizza", "grill", "bakery", "kitchen_banquet",
  "espresso", "alt_brew", "latte_art",
  "classic_cocktails", "signature_cocktails", "hookah",
  "banquets", "big_hall", "wine", "english_menu",
  "cash", "iiko", "rkeeper", "poster",
  "display", "onec", "receiving",
  "own_car", "own_bike", "knows_city",
  "picking", "tsd", "forklift",
] as const;

/** Прошлое место работы: заведение, кем и сколько. */
export interface Job {
  place: string;
  role: string;
  term: (typeof JOB_TERM)[number];
}

/** Дом: точка, округлённая до 300–500 метров. Видит только сам соискатель. */
export interface Home {
  lat: number;
  lon: number;
  source: HomeSource;
}

export interface Profile {
  name: string;
  city: string;
  /** Район из прежней анкеты (до 2026-11-04.2): новое приложение вместо него спрашивает, где дом. */
  district: string | null;
  home: Home | null;
  roles: string[];
  /** null — ещё не указан: короткая анкета спрашивает только имя и профессии. */
  experience: (typeof EXPERIENCE)[number] | null;
  employment: (typeof EMPLOYMENT)[number][];
  pay_from: number | null;
  pay_period: (typeof PAY_PERIOD)[number] | null;
  start: (typeof START)[number] | null;
  phone: string | null;
  languages: (typeof LANGUAGES)[number][];
  about: string | null;
  /** То же, что med === "yes": для приложения до 2026-11-16, которое знает только галочку. */
  med_book: boolean;
  driver: boolean;
  jobs: Job[];
  skills: (typeof SKILLS)[number][];
  /** null — человек не отвечал про санкнижку. */
  med: (typeof MED)[number] | null;
  trial: boolean;
  /** Когда человек последний раз отметил «ищу работу сейчас»; см. isLooking. */
  looking_at: string | null;
}

/** Горит ли отметка «ищу работу сейчас»: она гаснет сама, чтобы в профиле не висела устаревшая. */
export const isLooking = (p: Pick<Profile, "looking_at">, now: number) =>
  !!p.looking_at && now - Date.parse(p.looking_at) < LOOKING_DAYS * 86_400_000;

const bad = (message: string) => new HttpError(400, message);

function text(value: unknown, field: string, max: number, required: boolean): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw bad(`Не заполнено поле ${field}`);
    return null;
  }
  if (typeof value !== "string") throw bad(`Поле ${field} должно быть строкой`);
  // Без управляющих символов и лишних пробелов: текст попадёт на страницу профиля и в сообщения
  const clean = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").trim();
  if (!clean) {
    if (required) throw bad(`Не заполнено поле ${field}`);
    return null;
  }
  if (clean.length > max) throw bad(`Поле ${field} длиннее ${max} знаков`);
  return clean;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw bad(`Поле ${field}: одно из ${allowed.join(", ")}`);
  }
  return value as T;
}

/** Поле по желанию: нет значения — null, есть — одно из разрешённых. */
const maybeOneOf = <T extends string>(value: unknown, allowed: readonly T[], field: string): T | null =>
  value === undefined || value === null || value === "" ? null : oneOf(value, allowed, field);

function someOf<T extends string>(value: unknown, allowed: readonly T[], field: string, min: number): T[] {
  if (!Array.isArray(value)) throw bad(`Поле ${field} должно быть списком`);
  const picked = allowed.filter((a) => value.includes(a));
  if (picked.length !== new Set(value).size) throw bad(`Поле ${field}: только ${allowed.join(", ")}`);
  if (picked.length < min) throw bad(`Поле ${field}: выберите хотя бы ${min}`);
  return picked;
}

/** Точка дома из приложения: lat, lon и откуда она (телефон или 2ГИС). Хранится округлённой. */
export function parseHome(value: unknown): Home | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad("Дом: нужна точка lat, lon");
  const { lat, lon, source } = value as Record<string, unknown>;
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw bad("Дом: нужна точка lat, lon");
  }
  if (!inKazakhstan({ lat, lon })) throw bad("Дом: точка не в Казахстане");
  return { lat: roundHome(lat), lon: roundHome(lon), source: oneOf(source, HOME_SOURCES, "home.source") };
}

/** +7 701 234-56-78, 87012345678, 7012345678 → +77012345678. Только номера Казахстана. */
export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith("7")) digits = `7${digits}`;
  return /^77\d{9}$/.test(digits) ? `+${digits}` : null;
}

function parseJobs(value: unknown): Job[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw bad("Поле jobs должно быть списком");
  if (value.length > MAX_JOBS) throw bad(`Не больше ${MAX_JOBS} мест работы`);
  return value.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw bad(`jobs[${i}]: нужны место, должность и срок`);
    const j = item as Record<string, unknown>;
    return {
      place: text(j.place, `jobs[${i}].place`, 60, true) as string,
      role: text(j.role, `jobs[${i}].role`, 60, true) as string,
      term: oneOf(j.term, JOB_TERM, `jobs[${i}].term`),
    };
  });
}

/** Проверяет анкету из приложения. Возвращает чистые значения или бросает 400 с понятной причиной. */
export function parseProfile(body: unknown): Profile {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("Нужна анкета");
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.roles)) throw bad("Поле roles должно быть списком");
  const roles = [...new Set(b.roles.map((r, i) => text(r, `roles[${i}]`, 60, true) as string))];
  if (!roles.length) throw bad("Выберите хотя бы одну профессию");
  if (roles.length > MAX_ROLES) throw bad(`Не больше ${MAX_ROLES} профессий`);

  let payFrom: number | null = null;
  let payPeriod: Profile["pay_period"] = null;
  if (b.pay_from !== undefined && b.pay_from !== null && b.pay_from !== "") {
    payFrom = Number(b.pay_from);
    if (!Number.isInteger(payFrom) || payFrom < 0 || payFrom > 10_000_000) throw bad("Зарплата: целое число тенге");
    payPeriod = oneOf(b.pay_period ?? "month", PAY_PERIOD, "pay_period");
  }

  let phone: string | null = null;
  if (b.phone !== undefined && b.phone !== null && b.phone !== "") {
    phone = typeof b.phone === "string" ? normalizePhone(b.phone) : null;
    if (!phone) throw bad("Телефон: номер Казахстана, например +7 701 234 56 78");
  }

  const skills = b.skills === undefined || b.skills === null ? [] : someOf(b.skills, SKILLS, "skills", 0);
  if (skills.length > MAX_SKILLS) throw bad(`Не больше ${MAX_SKILLS} навыков`);
  // Старое приложение присылает только галочку med_book
  const med = maybeOneOf(b.med, MED, "med") ?? (b.med_book === true ? "yes" : null);

  return {
    name: text(b.name, "name", 40, true) as string,
    city: oneOf(b.city, CITIES, "city"),
    district: text(b.district, "district", 60, false),
    // Старое приложение дом не присылает: тогда сервер оставляет прежний (me.ts)
    home: b.home === undefined ? null : parseHome(b.home),
    roles,
    experience: maybeOneOf(b.experience, EXPERIENCE, "experience"),
    employment: b.employment === undefined || b.employment === null ? [] : someOf(b.employment, EMPLOYMENT, "employment", 0),
    pay_from: payFrom,
    pay_period: payPeriod,
    start: maybeOneOf(b.start, START, "start"),
    phone,
    languages: b.languages === undefined ? [] : someOf(b.languages, LANGUAGES, "languages", 0),
    about: text(b.about, "about", 300, false),
    med_book: med === "yes",
    driver: b.driver === true,
    jobs: parseJobs(b.jobs),
    skills,
    med,
    trial: b.trial === true,
    // «Ищу сейчас» приложение присылает полем looking: дату ставит сервер (me.ts)
    looking_at: null,
  };
}

export type Tip = "work" | "details" | "video" | "photo" | "docs" | "phone" | "about";

/**
 * Сила профиля: анкета 45%, кружок 25%, фото 10%, телефон 10%, «о себе» 5%, документы 5%.
 * next — что добавить первым, чтобы профиль стал сильнее.
 */
export function strength(p: Profile, has: { video: boolean; photo: boolean }): { percent: number; next: Tip | null } {
  const parts: [Tip, number, boolean][] = [
    // Где работал и что умеет: это работодатель общепита смотрит первым, и отвечается оно кнопками
    ["work", 20, p.jobs.length > 0 || p.skills.length > 0],
    // Опыт, график и выход: короткая анкета их не спрашивает
    ["details", 15, !!p.experience && p.employment.length > 0 && !!p.start],
    ["video", 15, has.video],
    ["photo", 10, has.photo],
    ["docs", 5, p.med !== null || p.driver],
    ["phone", 5, !!p.phone],
    ["about", 5, !!p.about],
  ];
  const percent = 25 + parts.reduce((sum, [, weight, done]) => sum + (done ? weight : 0), 0);
  return { percent, next: parts.find(([, , done]) => !done)?.[0] ?? null };
}

/** Строка из базы → анкета. */
export function fromRow(row: Record<string, unknown>): Profile {
  return {
    name: String(row.name),
    city: String(row.city),
    district: (row.district as string | null) ?? null,
    home:
      typeof row.home_lat === "number" && typeof row.home_lon === "number"
        ? { lat: row.home_lat, lon: row.home_lon, source: (row.home_source as HomeSource | null) ?? "phone" }
        : null,
    roles: JSON.parse(String(row.roles)) as string[],
    experience: (row.experience as Profile["experience"]) || null,
    employment: JSON.parse(String(row.employment)) as Profile["employment"],
    pay_from: (row.pay_from as number | null) ?? null,
    pay_period: (row.pay_period as Profile["pay_period"]) ?? null,
    start: (row.start as Profile["start"]) || null,
    phone: (row.phone as string | null) ?? null,
    languages: JSON.parse(String(row.languages ?? "[]")) as Profile["languages"],
    about: (row.about as string | null) ?? null,
    med_book: row.med === "yes",
    driver: row.driver === 1,
    jobs: JSON.parse(String(row.jobs ?? "[]")) as Job[],
    skills: JSON.parse(String(row.skills ?? "[]")) as Profile["skills"],
    med: (row.med as Profile["med"]) ?? null,
    trial: row.trial === 1,
    looking_at: (row.looking_at as string | null) ?? null,
  };
}

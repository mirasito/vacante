// Анкета соискателя: что можно заполнить, проверка того, что прислало приложение, и сила профиля.
import { HttpError } from "./http.ts";

/** Версия текста согласия. Меняется вместе с текстом в приложении (app/src/profile/consent.ts). */
export const CONSENT_VERSION = "2026-11-04";

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

export interface Profile {
  name: string;
  city: string;
  district: string | null;
  roles: string[];
  experience: (typeof EXPERIENCE)[number];
  employment: (typeof EMPLOYMENT)[number][];
  pay_from: number | null;
  pay_period: (typeof PAY_PERIOD)[number] | null;
  start: (typeof START)[number];
  phone: string | null;
  languages: (typeof LANGUAGES)[number][];
  about: string | null;
  med_book: boolean;
  driver: boolean;
}

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

function someOf<T extends string>(value: unknown, allowed: readonly T[], field: string, min: number): T[] {
  if (!Array.isArray(value)) throw bad(`Поле ${field} должно быть списком`);
  const picked = allowed.filter((a) => value.includes(a));
  if (picked.length !== new Set(value).size) throw bad(`Поле ${field}: только ${allowed.join(", ")}`);
  if (picked.length < min) throw bad(`Поле ${field}: выберите хотя бы ${min}`);
  return picked;
}

/** +7 701 234-56-78, 87012345678, 7012345678 → +77012345678. Только номера Казахстана. */
export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith("7")) digits = `7${digits}`;
  return /^77\d{9}$/.test(digits) ? `+${digits}` : null;
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

  return {
    name: text(b.name, "name", 40, true) as string,
    city: oneOf(b.city, CITIES, "city"),
    district: text(b.district, "district", 60, false),
    roles,
    experience: oneOf(b.experience, EXPERIENCE, "experience"),
    employment: someOf(b.employment, EMPLOYMENT, "employment", 1),
    pay_from: payFrom,
    pay_period: payPeriod,
    start: oneOf(b.start, START, "start"),
    phone,
    languages: b.languages === undefined ? [] : someOf(b.languages, LANGUAGES, "languages", 0),
    about: text(b.about, "about", 300, false),
    med_book: b.med_book === true,
    driver: b.driver === true,
  };
}

export type Tip = "video" | "phone" | "about" | "docs";

/**
 * Сила профиля: анкета 50%, кружок 30%, телефон 10%, «о себе» 5%, документы 5%.
 * next — что добавить первым, чтобы профиль стал сильнее.
 */
export function strength(p: Profile, hasVideo: boolean): { percent: number; next: Tip | null } {
  const parts: [Tip, number, boolean][] = [
    ["video", 30, hasVideo],
    ["phone", 10, !!p.phone],
    ["about", 5, !!p.about],
    ["docs", 5, p.med_book || p.driver],
  ];
  const percent = 50 + parts.reduce((sum, [, weight, done]) => sum + (done ? weight : 0), 0);
  return { percent, next: parts.find(([, , done]) => !done)?.[0] ?? null };
}

/** Строка из базы → анкета. */
export function fromRow(row: Record<string, unknown>): Profile {
  return {
    name: String(row.name),
    city: String(row.city),
    district: (row.district as string | null) ?? null,
    roles: JSON.parse(String(row.roles)) as string[],
    experience: row.experience as Profile["experience"],
    employment: JSON.parse(String(row.employment)) as Profile["employment"],
    pay_from: (row.pay_from as number | null) ?? null,
    pay_period: (row.pay_period as Profile["pay_period"]) ?? null,
    start: row.start as Profile["start"],
    phone: (row.phone as string | null) ?? null,
    languages: JSON.parse(String(row.languages ?? "[]")) as Profile["languages"],
    about: (row.about as string | null) ?? null,
    med_book: row.med_book === 1,
    driver: row.driver === 1,
  };
}

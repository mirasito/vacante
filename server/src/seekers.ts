// Соискатели в базе: создание после согласия, анкета, фото, ссылки на профиль, просмотры и удаление.
import { randomInt } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { tx, type Db } from "./db.ts";
import { fromRow, strength, type Profile } from "./profile.ts";

// Без похожих друг на друга знаков (0/o, 1/l/i), чтобы код можно было продиктовать
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const CODE_LENGTH = 8;
export const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

export function randomCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

export const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export interface Seeker {
  id: number;
  first_name: string;
  lang: "ru" | "kk";
  consent_version: string;
  consent_at: string;
  base_consent_at: string | null;
  write_access: number;
  /** Когда соискатель включил фото в превью ссылки; null — выключено. */
  preview_at: string | null;
  created_at: string;
  seen_at: string;
}

export interface Video {
  file_id: string;
  file_unique_id: string;
  file: string | null;
  poster: string | null;
  duration: number;
  size: number | null;
  recorded_at: string;
}

export interface Photo {
  file: string;
  width: number;
  height: number;
  size: number;
  uploaded_at: string;
}

export function getSeeker(db: Db, id: number): Seeker | undefined {
  return db.prepare("SELECT * FROM seekers WHERE id = ?").get(id) as Seeker | undefined;
}

export function getProfile(db: Db, id: number): Profile | undefined {
  const row = db.prepare("SELECT * FROM profiles WHERE seeker_id = ?").get(id) as Record<string, unknown> | undefined;
  return row && fromRow(row);
}

export function profileUpdatedAt(db: Db, id: number): string | undefined {
  const row = db.prepare("SELECT updated_at FROM profiles WHERE seeker_id = ?").get(id) as { updated_at: string } | undefined;
  return row?.updated_at;
}

export function getVideo(db: Db, id: number): Video | undefined {
  return db.prepare("SELECT * FROM videos WHERE seeker_id = ?").get(id) as Video | undefined;
}

export function getPhoto(db: Db, id: number): Photo | undefined {
  return db.prepare("SELECT file, width, height, size, uploaded_at FROM photos WHERE seeker_id = ?").get(id) as Photo | undefined;
}

export function createSeeker(
  db: Db,
  s: { id: number; first_name: string; lang: "ru" | "kk"; consent_version: string; base: boolean; now: number },
) {
  db.prepare(
    `INSERT INTO seekers (id, first_name, lang, consent_version, consent_at, base_consent_at, created_at, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(s.id, s.first_name, s.lang, s.consent_version, iso(s.now), s.base ? iso(s.now) : null, iso(s.now), iso(s.now));
}

export function saveProfile(db: Db, id: number, p: Profile, now: number) {
  db.prepare(
    `INSERT INTO profiles (seeker_id, name, city, district, home_lat, home_lon, home_source, roles, experience, employment,
       pay_from, pay_period, start, phone, languages, about, med_book, driver, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (seeker_id) DO UPDATE SET name = excluded.name, city = excluded.city, district = excluded.district,
       home_lat = excluded.home_lat, home_lon = excluded.home_lon, home_source = excluded.home_source,
       roles = excluded.roles, experience = excluded.experience, employment = excluded.employment,
       pay_from = excluded.pay_from, pay_period = excluded.pay_period, start = excluded.start, phone = excluded.phone,
       languages = excluded.languages, about = excluded.about, med_book = excluded.med_book, driver = excluded.driver,
       updated_at = excluded.updated_at`,
  ).run(
    id, p.name, p.city, p.district, p.home?.lat ?? null, p.home?.lon ?? null, p.home?.source ?? null,
    JSON.stringify(p.roles), p.experience, JSON.stringify(p.employment), p.pay_from, p.pay_period, p.start, p.phone,
    JSON.stringify(p.languages), p.about, p.med_book ? 1 : 0, p.driver ? 1 : 0, iso(now),
  );
}

/** Сколько ждём контакт после того, как приложение попросило номер кнопкой Telegram. */
export const PHONE_ASK_MINUTES = 10;

/** Приложение сейчас попросит номер: контакт, который придёт боту, относится к профилю. */
export function askPhone(db: Db, id: number, now: number): boolean {
  const { changes } = db.prepare(
    "UPDATE seekers SET phone_asked_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM profiles WHERE seeker_id = ?)",
  ).run(iso(now), id, id);
  return Number(changes) > 0;
}

/** Человек закрыл окно Telegram, не поделившись: контакты снова относятся к откликам в боте. */
export function cancelPhoneAsk(db: Db, id: number) {
  db.prepare("UPDATE seekers SET phone_asked_at = NULL WHERE id = ?").run(id);
}

/** Ждём ли от этого человека номер для профиля (иначе контакт в чате бота относится к отклику). */
export function phoneAsked(db: Db, id: number, now: number): boolean {
  const row = db.prepare("SELECT phone_asked_at AS at FROM seekers WHERE id = ?").get(id) as { at: string | null } | undefined;
  if (!row?.at) return false;
  const age = now - Date.parse(row.at);
  return age >= 0 && age <= PHONE_ASK_MINUTES * 60_000;
}

/** Номер, которым человек поделился в чате бота: его собственный, Telegram это проверил. */
export function setPhone(db: Db, id: number, phone: string, now: number): boolean {
  return tx(db, () => {
    const { changes } = db.prepare("UPDATE profiles SET phone = ?, updated_at = ? WHERE seeker_id = ?").run(phone, iso(now), id);
    db.prepare("UPDATE seekers SET phone_asked_at = NULL WHERE id = ?").run(id);
    return Number(changes) > 0;
  });
}

export function touchSeeker(db: Db, id: number, patch: { lang?: "ru" | "kk"; first_name?: string }, now: number) {
  db.prepare(
    `UPDATE seekers SET seen_at = ?, lang = COALESCE(?, lang), first_name = COALESCE(?, first_name) WHERE id = ?`,
  ).run(iso(now), patch.lang ?? null, patch.first_name ?? null, id);
}

export function setBaseConsent(db: Db, id: number, base: boolean, now: number) {
  // Дата первого согласия сохраняется, пока человек его не отозвал
  db.prepare(
    `UPDATE seekers SET base_consent_at = CASE WHEN ? THEN COALESCE(base_consent_at, ?) ELSE NULL END WHERE id = ?`,
  ).run(base ? 1 : 0, iso(now), id);
}

/** Галочка «Показывать фото в превью ссылки»: дата первого включения сохраняется, пока её не сняли. */
export function setPreview(db: Db, id: number, on: boolean, now: number) {
  db.prepare(`UPDATE seekers SET preview_at = CASE WHEN ? THEN COALESCE(preview_at, ?) ELSE NULL END WHERE id = ?`).run(
    on ? 1 : 0,
    iso(now),
    id,
  );
}

export function setWriteAccess(db: Db, id: number, allowed: boolean) {
  db.prepare("UPDATE seekers SET write_access = ? WHERE id = ?").run(allowed ? 1 : 0, id);
}

export interface Link {
  code: string;
  seeker_id: number;
  application_id: number | null;
  active: number;
  created_at: string;
  expires_at: string | null;
}

/** Работающая ссылка: включена и не истекла. */
export function findLink(db: Db, code: string, now: number): Link | undefined {
  return db
    .prepare("SELECT * FROM links WHERE code = ? AND active = 1 AND (expires_at IS NULL OR expires_at > ?)")
    .get(code, iso(now)) as Link | undefined;
}

export function sharedLink(db: Db, id: number): Link | undefined {
  return db
    .prepare("SELECT * FROM links WHERE seeker_id = ? AND application_id IS NULL AND active = 1 ORDER BY created_at DESC")
    .get(id) as Link | undefined;
}

function insertLink(db: Db, id: number, applicationId: number | null, expiresAt: string | null, now: number): string {
  for (;;) {
    const code = randomCode();
    const { changes } = db
      .prepare("INSERT OR IGNORE INTO links (code, seeker_id, application_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(code, id, applicationId, iso(now), expiresAt);
    if (Number(changes)) return code;
  }
}

/** Новая общая ссылка: прежняя перестаёт открываться. */
export function newSharedLink(db: Db, id: number, now: number): string {
  return tx(db, () => {
    dropSharedLink(db, id);
    return insertLink(db, id, null, null, now);
  });
}

export function dropSharedLink(db: Db, id: number) {
  db.prepare("UPDATE links SET active = 0 WHERE seeker_id = ? AND application_id IS NULL AND active = 1").run(id);
}

/** Ссылка отклика работает 60 дней. */
export const APPLICATION_LINK_DAYS = 60;

export function applicationLink(db: Db, id: number, applicationId: number, now: number): string {
  return insertLink(db, id, applicationId, iso(now + APPLICATION_LINK_DAYS * 86_400_000), now);
}

export function recordView(
  db: Db,
  v: { seeker_id: number; link_code: string; application_id: number | null; viewer: string | null; phone: boolean; now: number },
) {
  db.prepare(
    "INSERT INTO views (seeker_id, link_code, application_id, viewer, phone_shown, at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(v.seeker_id, v.link_code, v.application_id, v.viewer, v.phone ? 1 : 0, iso(v.now));
}

export interface View {
  at: string;
  via: "link" | "application";
  viewer: string | null;
  phone_shown: boolean;
}

export function listViews(db: Db, id: number, limit = 50): View[] {
  const rows = db
    .prepare("SELECT at, application_id, viewer, phone_shown FROM views WHERE seeker_id = ? ORDER BY at DESC, id DESC LIMIT ?")
    .all(id, limit) as { at: string; application_id: number | null; viewer: string | null; phone_shown: number }[];
  return rows.map((r) => ({
    at: r.at,
    via: r.application_id ? "application" : "link",
    viewer: r.viewer,
    phone_shown: r.phone_shown === 1,
  }));
}

export function removeFiles(dir: string, files: (string | null | undefined)[]) {
  for (const file of files) if (file) rmSync(join(dir, file), { force: true });
}

export interface NewVideo {
  file_id: string;
  file_unique_id: string;
  /** Имена файлов в папке кружков. */
  file: string;
  poster: string | null;
  duration: number;
  size: number;
  /** Когда кружок отправлен в чат бота. */
  recorded_at: string;
}

/**
 * Кладёт скачанный кружок в профиль вместо прежнего. Возвращает файлы прежнего кружка, которые
 * пора удалить, или null, если этот кружок уже не нужен: профиль удалили, пока он скачивался,
 * или за это время пришёл кружок новее.
 */
export function putVideo(db: Db, id: number, v: NewVideo): string[] | null {
  return tx(db, () => {
    if (!db.prepare("SELECT 1 FROM profiles WHERE seeker_id = ?").get(id)) return null;
    const old = getVideo(db, id);
    if (old && old.recorded_at > v.recorded_at) return null;
    db.prepare(
      `INSERT INTO videos (seeker_id, file_id, file_unique_id, file, poster, duration, size, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(seeker_id) DO UPDATE SET file_id = excluded.file_id, file_unique_id = excluded.file_unique_id,
         file = excluded.file, poster = excluded.poster, duration = excluded.duration, size = excluded.size,
         recorded_at = excluded.recorded_at`,
    ).run(id, v.file_id, v.file_unique_id, v.file, v.poster, v.duration, v.size, v.recorded_at);
    return old ? [old.file, old.poster].filter((f): f is string => !!f) : [];
  });
}

/**
 * Кладёт новое фото в профиль вместо прежнего. Возвращает файл прежнего фото, который пора удалить
 * (или null, если его не было), либо false, если профиля нет: фото без анкеты не нужно.
 */
export function putPhoto(db: Db, id: number, photo: Omit<Photo, "uploaded_at">, now: number): string | null | false {
  return tx(db, () => {
    if (!db.prepare("SELECT 1 FROM profiles WHERE seeker_id = ?").get(id)) return false;
    const old = getPhoto(db, id);
    db.prepare(
      `INSERT INTO photos (seeker_id, file, width, height, size, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(seeker_id) DO UPDATE SET file = excluded.file, width = excluded.width, height = excluded.height,
         size = excluded.size, uploaded_at = excluded.uploaded_at`,
    ).run(id, photo.file, photo.width, photo.height, photo.size, iso(now));
    return old?.file ?? null;
  });
}

/** «Удалить фото»: строка и файл. false, если фото не было. */
export function dropPhoto(db: Db, id: number, dir: string): boolean {
  const old = getPhoto(db, id);
  if (!old) return false;
  db.prepare("DELETE FROM photos WHERE seeker_id = ?").run(id);
  removeFiles(dir, [old.file]);
  return true;
}

/** «Удалить кружок»: строка и файлы. false, если кружка не было. */
export function dropVideo(db: Db, id: number, videosDir: string): boolean {
  const old = getVideo(db, id);
  if (!old) return false;
  db.prepare("DELETE FROM videos WHERE seeker_id = ?").run(id);
  removeFiles(videosDir, [old.file, old.poster]);
  return true;
}

/** «Удалить профиль»: сразу стирает анкету, кружок, фото, ссылки и просмотры, файлы тоже. */
export function deleteSeeker(db: Db, id: number, videosDir: string) {
  const video = getVideo(db, id);
  const photo = getPhoto(db, id);
  db.prepare("DELETE FROM seekers WHERE id = ?").run(id);
  removeFiles(videosDir, [video?.file, video?.poster, photo?.file]);
}

/** Всё о профиле для самого соискателя (GET /me/profile). */
export function profileView(db: Db, id: number, profileOrigin: string) {
  const seeker = getSeeker(db, id);
  if (!seeker) return null;
  const profile = getProfile(db, id) ?? null;
  const video = getVideo(db, id);
  const photo = getPhoto(db, id);
  const link = sharedLink(db, id);
  return {
    seeker: {
      first_name: seeker.first_name,
      lang: seeker.lang,
      consent_at: seeker.consent_at,
      base: !!seeker.base_consent_at,
      write_access: seeker.write_access === 1,
      preview: !!seeker.preview_at,
    },
    profile,
    video: video ? { duration: video.duration, recorded_at: video.recorded_at, ready: !!video.file, poster: !!video.poster } : null,
    photo: photo ? { width: photo.width, height: photo.height, uploaded_at: photo.uploaded_at } : null,
    strength: profile ? strength(profile, { video: !!video?.file, photo: !!photo }) : null,
    link: link ? { code: link.code, url: `${profileOrigin}/${link.code}` } : null,
  };
}

import { telegram } from './platform';

// Сервер Vacante в Казахстане (server/ в репозитории): профили, отклики, напоминания.
// Приложение входит на него подписанными данными Telegram, без паролей.
export const API_URL = 'https://api.vacante.kz';

export interface Account {
  id: number;
  first_name: string;
  /** Профили открыты для всех (иначе только для тестировщиков). */
  open: boolean;
  /** Профиль уже создан. */
  profile: boolean;
}

export type Experience = 'none' | 'lt1' | '1to3' | 'gt3';
export type Employment = 'full' | 'shifts' | 'part' | 'rotation';
export type Start = 'today' | 'week' | '2weeks' | 'later';
export type PayPeriod = 'month' | 'shift';
export type Language = 'kk' | 'ru' | 'en';
export type Tip = 'video' | 'phone' | 'about' | 'docs';

export interface Profile {
  name: string;
  city: string;
  district: string | null;
  roles: string[];
  experience: Experience;
  employment: Employment[];
  pay_from: number | null;
  pay_period: PayPeriod | null;
  start: Start;
  phone: string | null;
  languages: Language[];
  about: string | null;
  med_book: boolean;
  driver: boolean;
}

export interface ProfileView {
  seeker: { first_name: string; lang: 'ru' | 'kk'; consent_at: string; base: boolean; write_access: boolean };
  profile: Profile | null;
  /** Кружок: poster — есть ли обложка (Telegram присылает её не всегда). */
  video: { duration: number; recorded_at: string; ready: boolean; poster: boolean } | null;
  strength: { percent: number; next: Tip | null } | null;
  link: { code: string; url: string } | null;
}

export interface ProfileViewEvent {
  at: string;
  via: 'link' | 'application';
  viewer: string | null;
  phone_shown: boolean;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Данные входа из Telegram, их сервер проверяет подписью бота. Вне Telegram их нет. */
const initData = () => telegram()?.initData || '';

let beta = false;
/** Тестировщик открыл приложение по ссылке ?startapp=beta: ему можно создать профиль до общего запуска. */
export const setBeta = (on: boolean) => {
  beta = on;
};

const authHeaders = (auth: string): Record<string, string> => ({
  Authorization: `tma ${auth}`,
  ...(beta ? { 'X-Vacante-Beta': '1' } : {}),
});

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const auth = initData();
  if (!auth) throw new ApiError(0, 'not in Telegram');
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...authHeaders(auth),
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data;
}

/** Кто вошёл. null, если открыто не в Telegram или сервер пока недоступен. */
export async function whoAmI(): Promise<Account | null> {
  if (!initData()) return null;
  try {
    const { user, open, profile } = await api<{ user: { id: number; first_name: string }; open: boolean; profile: boolean }>(
      '/me',
    );
    return { id: user.id, first_name: user.first_name, open, profile };
  } catch {
    return null;
  }
}

/** Профиль или null, если его ещё нет. */
export async function getProfile(): Promise<ProfileView | null> {
  try {
    return await api<ProfileView>('/me/profile');
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export const CONSENT_VERSION = '2026-11-04';

export const saveProfile = (profile: Profile, lang: 'ru' | 'kk', consent?: { adult: boolean; base: boolean }) =>
  api<ProfileView>('/me/profile', {
    method: 'PUT',
    body: { profile, lang, ...(consent ? { consent: { version: CONSENT_VERSION, ...consent } } : {}) },
  });

export const patchMe = (patch: { lang?: 'ru' | 'kk'; base?: boolean; write_access?: boolean }) =>
  api<ProfileView>('/me', { method: 'PATCH', body: patch });

/** Сейчас откроется окно Telegram «Поделиться номером»: контакт, пришедший боту, относится к профилю. */
export const askPhone = () => api<{ ok: boolean; minutes: number }>('/me/phone/ask', { method: 'POST' });
export const cancelPhone = () => api<{ ok: boolean }>('/me/phone/ask', { method: 'DELETE' });

export const deleteMe = () => api<{ deleted: boolean }>('/me', { method: 'DELETE' });
export const newLink = () => api<{ code: string; url: string }>('/me/link', { method: 'POST' });
export const dropLink = () => api<{ ok: boolean }>('/me/link', { method: 'DELETE' });
export const getViews = async () => (await api<{ views: ProfileViewEvent[] }>('/me/views')).views;

/** Убрать кружок из профиля. */
export const deleteVideo = () => api<ProfileView>('/me/video', { method: 'DELETE' });

/**
 * Свой кружок или его обложка как адрес blob:… для <video> и <Image>. Файлы закрыты входом
 * Telegram, а заголовок Authorization тегу не передать, поэтому скачиваем сами.
 * null, если файла нет, сервер недоступен или это не браузер.
 */
export async function mediaUrl(path: '/me/video' | '/me/video/poster'): Promise<string | null> {
  const auth = initData();
  if (!auth || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  try {
    const res = await fetch(`${API_URL}${path}`, { headers: authHeaders(auth) });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}

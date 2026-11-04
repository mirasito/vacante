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
export type Employment = 'full' | 'shifts' | 'night' | 'flexible' | 'part' | 'weekends' | 'rotation';
export type Start = 'today' | 'week' | '2weeks' | 'later';
export type PayPeriod = 'month' | 'shift';
export type Language = 'kk' | 'ru' | 'en';
export type Tip = 'video' | 'photo' | 'phone' | 'about' | 'docs';

/** Где живёт человек: точка, округлённая сервером до 300–500 метров. Работодатель её не видит. */
export interface Home {
  lat: number;
  lon: number;
  source: 'phone' | '2gis';
}

export interface Profile {
  name: string;
  city: string;
  /** Район из прежней анкеты: новое приложение вместо него спрашивает, где дом. */
  district: string | null;
  home: Home | null;
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
  photo: { width: number; height: number; uploaded_at: string } | null;
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

export const CONSENT_VERSION = '2026-11-04.2';

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

/** Фото в профиль: JPEG, уже уменьшенный на телефоне (profile/photo.ts). */
export async function putPhoto(photo: Blob): Promise<ProfileView> {
  const auth = initData();
  if (!auth) throw new ApiError(0, 'not in Telegram');
  const res = await fetch(`${API_URL}/me/photo`, {
    method: 'PUT',
    headers: { ...authHeaders(auth), 'Content-Type': 'image/jpeg' },
    body: photo,
  });
  const data = (await res.json().catch(() => ({}))) as ProfileView & { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data;
}

export const deletePhoto = () => api<ProfileView>('/me/photo', { method: 'DELETE' });

/** Дом по ссылке из 2ГИС: точка и подпись 2ГИС, чтобы человек проверил, его ли это дом. Ничего не сохраняет. */
export const homeFromLink = (link: string) =>
  api<Home & { label: string | null }>('/me/home/link', { method: 'POST', body: { link } });

/**
 * Свой кружок, его обложка или фото как адрес blob:… для <video> и <Image>. Файлы закрыты входом
 * Telegram, а заголовок Authorization тегу не передать, поэтому скачиваем сами.
 * null, если файла нет, сервер недоступен или это не браузер.
 */
export async function mediaUrl(path: '/me/video' | '/me/video/poster' | '/me/photo'): Promise<string | null> {
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

// Отклики: стадии, способ, своя ссылка на профиль у каждого (server/src/applications.ts)
export type Stage =
  | 'liked'
  | 'sent'
  | 'seen'
  | 'invited'
  | 'interview'
  | 'offer'
  | 'hired'
  | 'rejected'
  | 'no_answer'
  | 'not_interested';
export type Method = 'whatsapp' | 'telegram' | 'call' | 'hh' | 'bot' | 'post';
export type SearchStage = 'looking' | 'applying' | 'interviews' | 'choosing' | 'working';
export type ContactKind = 'whatsapp' | 'phone' | 'telegram';

/** Копия вакансии в отклике: то, что было в ленте на момент отклика. */
export interface VacancyCopy {
  id: string;
  title: string;
  title_kk: string | null;
  employer: string | null;
  city: string | null;
  address: string | null;
  /** Адрес в 2ГИС. */
  map: string | null;
  url: string | null;
  source_url: string | null;
  contact: ContactKind[];
}

export interface ApplicationEvent {
  stage: Stage;
  by: 'seeker' | 'employer' | 'system';
  at: string;
}

export interface Application {
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
  /** Когда работодатель впервые открыл ссылку отклика и сколько раз открывал. */
  seen_at: string | null;
  views: number;
  link: { code: string; url: string } | null;
  events?: ApplicationEvent[];
}

/** Цель недели: сколько откликов отправить с понедельника по воскресенье. */
export const GOALS = [3, 5, 10] as const;
export type GoalValue = (typeof GOALS)[number];

export interface Goal {
  /** null — цели нет. */
  goal: GoalValue | null;
  /** Отправлено на этой неделе. */
  sent: number;
  /** Недель подряд с выполненной целью, вместе с этой, если она уже выполнена. */
  streak: number;
  /** Прошлую неделю не выполнили, но серия сохранилась: один пропуск в месяц можно. */
  forgiven: boolean;
}

export const ACHIEVEMENTS = ['video', 'first_sent', 'first_invite', 'first_interview', 'hired'] as const;
export type AchievementKind = (typeof ACHIEVEMENTS)[number];

export interface Achievement {
  kind: AchievementKind;
  at: string;
  /** Приложение уже поздравило. */
  seen: boolean;
}

export interface Summary {
  stage: SearchStage;
  week: { from: string; sent: number; seen: number; invited: number };
  next_interview: { id: number; at: string; title: string; employer: string | null; address: string | null } | null;
  counts: Record<Stage, number>;
  goal: Goal;
  achievements: Achievement[];
}

/** Готовый текст отклика и отдельно строка со ссылкой на профиль. */
export interface Message {
  text: string;
  link_text: string;
}

export type ApplicationPatch = Partial<Pick<Application, 'stage' | 'method' | 'interview_at' | 'start_at' | 'note'>>;

/** Лайк или отклик, сделанный на телефоне до профиля. */
export interface ImportItem extends ApplicationPatch {
  vacancy: VacancyCopy;
  liked_at: string;
  sent_at?: string | null;
}

export const listApplications = () => api<{ applications: Application[]; summary: Summary }>('/me/applications');

/** «Хочу сюда»: отклик со стадией «Нравится», его ссылка и готовый текст. Для той же вакансии — тот же отклик. */
export const startApplication = (vacancy: VacancyCopy, lang: 'ru' | 'kk') =>
  api<{ application: Application; message: Message | null }>('/me/applications', {
    method: 'POST',
    body: { vacancy, lang },
  });

export const importApplications = (items: ImportItem[]) =>
  api<{ imported: number; applications: Application[]; summary: Summary }>('/me/applications/import', {
    method: 'POST',
    body: { items },
  });

export const getApplication = (id: number) => api<Application>(`/me/applications/${id}`);

export const patchApplication = (id: number, patch: ApplicationPatch) =>
  api<{ application: Application; summary: Summary }>(`/me/applications/${id}`, { method: 'PATCH', body: patch });

export const deleteApplication = (id: number) =>
  api<{ deleted: boolean; summary: Summary }>(`/me/applications/${id}`, { method: 'DELETE' });

/** Цель недели: 3, 5 или 10 откликов; null выключает. */
export const putGoal = (goal: GoalValue | null) => api<{ summary: Summary }>('/me/goal', { method: 'PUT', body: { goal } });

/** Цель с телефона, заведённая до профиля, с прошлыми неделями. Сервер берёт её, только если своей цели нет. */
export const importGoal = (goal: GoalValue | null, history: { week: string; goal: number }[]) =>
  api<{ summary: Summary }>('/me/goal/import', { method: 'POST', body: { goal, history } });

/** Поздравление с новыми достижениями показано. */
export const seenAchievements = () => api<{ ok: boolean }>('/me/achievements/seen', { method: 'POST' });

/** Контакт работодателя из исходного поста: сервер берёт его в момент запроса и не хранит. */
export interface PostContact {
  whatsapp: string | null;
  phone: string | null;
  telegram: string | null;
  /** Сколько ещё вакансий с номером можно открыть сегодня. */
  left: number;
}

export const lookupContact = (vacancyId: string, sourceUrl: string) =>
  api<PostContact>('/me/contact', { method: 'POST', body: { vacancy_id: vacancyId, source_url: sourceUrl } });

// Напоминания: системные сервер сам выводит из откликов и профиля, свои человек заводит сам
// (server/src/reminders.ts). В бот они приходят с 9:00 до 21:00 и не больше двух в день
export type ReminderKind =
  | 'write_again'
  | 'status_check'
  | 'interview_eve'
  | 'interview_soon'
  | 'how_was_it'
  | 'start_eve'
  | 'profile'
  | 'week'
  | 'custom';
/** Группы, которые включают и выключают в профиле. Свои напоминания не выключаются. */
export type ReminderGroup = 'applications' | 'interviews' | 'start' | 'profile' | 'week';
export const REMINDER_GROUPS: ReminderGroup[] = ['applications', 'interviews', 'start', 'profile', 'week'];

export interface Reminder {
  id: number;
  kind: ReminderKind;
  /** Текст своего напоминания. */
  text: string | null;
  due_at: string;
  expires_at: string | null;
  status: 'waiting' | 'sent' | 'done' | 'dismissed';
  closed_by: 'seeker' | 'system' | null;
  sent_at: string | null;
  /** Ещё ждёт действия: не сделано, не убрано и не прошло. */
  active: boolean;
  application:
    | (Omit<VacancyCopy, 'id'> & {
        id: number;
        vacancy_id: string;
        method: Method | null;
        stage: Stage;
        interview_at: string | null;
        start_at: string | null;
      })
    | null;
  /** У итога недели: цифры прошлой недели. */
  week?: { sent: number; seen: number; invited: number };
}

export interface ReminderSettings {
  off: ReminderGroup[];
  /** Присылать ли в чат бота. В приложении напоминания видны всегда. */
  bot: boolean;
}

export interface Reminders {
  /** Сначала то, что ждёт, по времени, потом история за 30 дней. */
  reminders: Reminder[];
  /** Сколько пора сделать сегодня: счётчик на вкладке. */
  due: number;
  settings: ReminderSettings;
}

export const listReminders = () => api<Reminders>('/me/reminders');

/** «Добавить своё»: at — время в UTC. */
export const addReminder = (text: string, at: string) =>
  api<Reminders & { id: number }>('/me/reminders', { method: 'POST', body: { text, at } });

/** «Готово», «Убрать» или «Отложить» (без until — на час, в окне с 9 до 21). */
export const actOnReminder = (id: number, action: 'done' | 'dismiss' | 'snooze', until?: string) =>
  api<Reminders>(`/me/reminders/${id}`, { method: 'PATCH', body: { action, ...(until ? { until } : {}) } });

export const saveReminderSettings = (settings: ReminderSettings) =>
  api<Reminders>('/me/reminders/settings', { method: 'PUT', body: settings });

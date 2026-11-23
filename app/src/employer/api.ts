// Запросы кабинета и формы размещения к боту (bot/src/cabinet.js, bot/src/webpost.js) и общие типы.
import { authHeader, initData, setSession } from '../session';

export const WORKER = 'https://vacante-bot.vacante-kz.workers.dev';
export const CABINET_URL = `${WORKER}/api/cabinet`;

export type CabinetJob = {
  id: number;
  kind: 'vacancy' | 'shift';
  title: string;
  company: string;
  city: string;
  salary: string;
  status: 'payment' | 'pending' | 'approved' | 'rejected' | 'closed';
  status_text: string;
  applications: number;
  confirmed?: number;
  need?: number;
  shift_date?: string;
  pro_until: string | null;
  url: string | null;
  pay: { amount: number; tariff: 'basic' | 'pro'; waiting: boolean } | null;
  boost: { price: number; days: number; shift: boolean; active?: boolean; waiting: boolean } | null;
};

export type CabinetState = {
  user: { id: number; first_name: string };
  admin: boolean;
  jobs: CabinetJob[];
  credits: number;
  kaspi: string | null;
  tariffs: { post: number; pro: number; days: number; shift_pro: number; packs: { count: number; price: number; days: number }[] } | null;
  pack_waiting: boolean;
  bot: string;
  /** Начатая вакансия: в форме на сайте или в анкете бота (bot/src/webpost.js draftView). */
  draft?: (PostFields & { id: number }) | null;
};

export type PostFields = {
  city: string;
  title: string;
  company: string;
  salary: string;
  schedule: string;
  address: string;
  details: string;
};

export type PostInfo = {
  cities: [string, string][];
  titles: string[];
  limits: Record<string, number>;
  required: string[];
  tariffs: { post: number; pro: number; days: number; packs: { count: number; price: number; days: number }[] } | null;
  bot: string;
};

export const POST_URL = `${WORKER}/api/post`;

export type Action = { action: string; id?: number; count?: number; text?: string; fields?: Partial<PostFields>; tariff?: string; from?: string };
export type ActionResult = CabinetState & { message?: string; error?: string; submitted?: number; outcome?: 'payment' | 'pending' };

export const money = (n: number) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₸`;

export class AuthError extends Error {}

export async function call(init?: Action): Promise<ActionResult> {
  const res = await fetch(CABINET_URL, {
    method: init ? 'POST' : 'GET',
    headers: { Authorization: authHeader(), ...(init ? { 'Content-Type': 'application/json' } : {}) },
    body: init ? JSON.stringify(init) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !initData()) {
    setSession('');  // ключ устарел: войти ещё раз
    throw new AuthError(data.error || 'auth');
  }
  if (init) {
    if (!data.state) throw new Error(data.error || `HTTP ${res.status}`);
    return { ...data.state, message: data.message, error: data.error, submitted: data.submitted, outcome: data.outcome };
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}


/** Открытая часть формы: города, тарифы, разбор текста и оформление (без входа). */
export async function postApi<T>(body?: object): Promise<T & { error?: string }> {
  const res = await fetch(POST_URL, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  return data;
}

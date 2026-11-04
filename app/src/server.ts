import { telegram } from './platform';

// Сервер Vacante в Казахстане (server/ в репозитории): профили, отклики, напоминания.
// Приложение входит на него подписанными данными Telegram, без паролей.
export const API_URL = 'https://api.vacante.kz';

export interface Account {
  id: number;
  first_name: string;
}

/** Данные входа из Telegram, их сервер проверяет подписью бота. Вне Telegram их нет. */
const initData = () => telegram()?.initData || '';

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const auth = initData();
  if (!auth) throw new Error('not in Telegram');
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `tma ${auth}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Кто вошёл. null, если открыто не в Telegram или сервер пока недоступен. */
export async function whoAmI(): Promise<Account | null> {
  if (!initData()) return null;
  try {
    const { user } = await api<{ user: Account }>('/me');
    return user;
  } catch {
    return null;
  }
}

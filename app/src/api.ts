import { Platform } from 'react-native';

import type { Index, Vacancy } from './types';

// Данные собирает сайт каждый час (vacante/site/appfeed.py). Веб-версия лежит на том же сайте
// в /app/ и берёт их со своего адреса, приложения из сторов — с vacante.kz.
export const DATA_URL = Platform.OS === 'web' ? '/app/data' : 'https://vacante.kz/app/data';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${DATA_URL}/${path}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const loadIndex = () => getJson<Index>('index.json');

export const loadCity = async (slug: string) =>
  (await getJson<{ vacancies: Vacancy[] }>(`${slug}.json`)).vacancies;

import { Platform } from 'react-native';

import type { Index, Vacancy } from './types';

// Данные собирает сайт каждый час (vacante/site/appfeed.py). Веб-версия лежит на том же сайте
// в /app/ и берёт их со своего адреса, приложения из сторов — с vacante.kz.
export const DATA_URL = Platform.OS === 'web' ? '/app/data' : 'https://vacante.kz/app/data';

/**
 * Сразу после запуска сеть телефона иногда отвечает не с первого раза (так было на эмуляторе
 * Android): если запрос не дошёл, ещё две попытки через 1 и 3 секунды, и только потом
 * «Нет связи с сервером». Ответ сервера с ошибкой не повторяем.
 */
const RETRY_MS = [1000, 3000];

async function getJson<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${DATA_URL}/${path}`, { cache: 'no-cache' });
    } catch (err) {
      const wait = RETRY_MS[attempt];
      if (wait === undefined) throw err;
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}

export const loadIndex = () => getJson<Index>('index.json');

/** Первая страница вакансий города (400 свежих), сколько их всего и сколько страниц. */
export const loadCity = async (slug: string) => {
  const r = await getJson<{ vacancies: Vacancy[]; total?: number; pages?: number }>(`${slug}.json`);
  return { items: r.vacancies, total: r.total ?? r.vacancies.length, pages: r.pages ?? 1 };
};

/** Следующие страницы города: app/data/<город>/p2.json, p3.json… */
export const loadPage = async (slug: string, n: number) =>
  (await getJson<{ vacancies: Vacancy[] }>(`${slug}/p${n}.json`)).vacancies;

/**
 * Вакансии одной профессии по всему городу: лента города держит только 400 свежих, а фильтр
 * «Профессия» должен находить все. Файла нет, если все вакансии профессии уже в ленте: тогда пусто.
 */
export const loadRole = async (city: string, key: string) => {
  try {
    return (await getJson<{ vacancies: Vacancy[] }>(`${city}/${key}.json`)).vacancies;
  } catch {
    return [];
  }
};

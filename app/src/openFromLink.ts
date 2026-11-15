/** Вакансия из ссылки запуска (кнопка «Откликнуться» под постом в канале) среди загруженной ленты города. */
export function findLaunched<T extends { id: string }>(items: T[], id: string | undefined): { vacancy?: T; closed: boolean } {
  if (!id) return { closed: false };
  const vacancy = items.find((v) => v.id === id);
  // Нет в свежих вакансиях города: её сняли или она ушла по возрасту. Показываем ленту и говорим об этом
  return vacancy ? { vacancy, closed: false } : { closed: true };
}

/** Сколько следующих страниц ленты просматриваем: пост в канале свежий, глубже вакансии быть не должно. */
const MAX_PAGES = 3;

/**
 * Вакансии нет среди 400 свежих: в большом городе за двое суток их выходит больше, поэтому ищем
 * на следующих страницах ленты (2…lastPage, не дальше трёх). Страница не загрузилась — не нашли.
 */
export async function findOnPages<T extends { id: string }>(
  id: string,
  lastPage: number,
  loadPage: (n: number) => Promise<T[]>,
): Promise<T | undefined> {
  for (let n = 2; n <= Math.min(lastPage, 1 + MAX_PAGES); n++) {
    let items: T[];
    try {
      items = await loadPage(n);
    } catch {
      return undefined;
    }
    const hit = items.find((v) => v.id === id);
    if (hit) return hit;
  }
  return undefined;
}

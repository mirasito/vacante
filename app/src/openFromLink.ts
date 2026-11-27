/** Вакансия из ссылки запуска (кнопка «Откликнуться» под постом в канале) среди загруженной ленты города. */
export function findLaunched<T extends { id: string }>(items: T[], id: string | undefined): { vacancy?: T; closed: boolean } {
  if (!id) return { closed: false };
  const vacancy = items.find((v) => v.id === id);
  // Нет в свежих вакансиях города: её сняли или она ушла по возрасту. Показываем ленту и говорим об этом
  return vacancy ? { vacancy, closed: false } : { closed: true };
}

/** Без списка id (старая сборка, сеть) просматриваем столько следующих страниц ленты. */
const MAX_PAGES = 3;

/** id вакансий города в порядке ленты и сколько их на странице (app/data/<город>/ids.json). */
export type FeedIds = { per_page: number; ids: string[] };

/**
 * Вакансии нет среди 400 свежих первой страницы: в большом городе её страницу находим по списку id
 * города и грузим только её. Список и страницы приходят из одной часовой сборки, но кеш мог отдать
 * их из разных, поэтому смотрим и соседние страницы. Нет в списке — вакансия закрыта.
 * Списка нет (не загрузился) — как раньше, страницы 2…4 по очереди. Страница не загрузилась — не нашли.
 */
export async function findOnPages<T extends { id: string }>(
  id: string,
  lastPage: number,
  loadPage: (n: number) => Promise<T[]>,
  ids?: Promise<FeedIds | undefined>,
): Promise<T | undefined> {
  if (lastPage < 2) return undefined;
  const list = ids ? await ids.catch(() => undefined) : undefined;
  let order: number[];
  if (list && Array.isArray(list.ids) && list.per_page > 0) {
    const at = list.ids.indexOf(id);
    if (at < 0) return undefined;
    const page = Math.floor(at / list.per_page) + 1;
    order = [page, page + 1, page - 1].filter((n) => n >= 2 && n <= lastPage);
  } else {
    order = [];
    for (let n = 2; n <= Math.min(lastPage, 1 + MAX_PAGES); n++) order.push(n);
  }
  for (const n of order) {
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

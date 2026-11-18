// Лента города: первая страница грузится в App.tsx вместе с просмотренным, а здесь — следующие страницы,
// вся лента целиком (для фильтров и «Рядом с домом») и вакансии выбранных профессий по всему городу.
// Вынесено из App.tsx как есть.
import { useCallback, useMemo, useRef, useState } from 'react';

import { loadPage, loadRole } from './api';
import type { Index, Vacancy } from './types';

export function useCityFeed(city: string | undefined, index: Index | null) {
  const [feed, setFeed] = useState<Vacancy[] | null>(null);
  /** Вакансии профессий по всему городу, сверх ленты: по названию профессии. */
  const [extra, setExtra] = useState<Record<string, Vacancy[]>>({});
  const extraCity = useRef<string | null>(null);
  /** Сколько вакансий в городе и страниц; какую страницу грузить следующей. */
  const [total, setTotal] = useState(0);
  const pages = useRef<{ city: string; next: number; last: number; busy: Promise<boolean> | null }>({ city: '', next: 2, last: 1, busy: null });

  /** Следующая страница вакансий города; false, когда страниц больше нет или город сменился. */
  const loadNext = useCallback((): Promise<boolean> => {
    const p = pages.current;
    if (!city || p.city !== city || p.next > p.last) return Promise.resolve(false);
    // Страница уже грузится (прокрутка и фильтр одновременно): ждём её, а не бросаем
    if (p.busy) return p.busy.then(() => pages.current === p && p.next <= p.last);
    const n = p.next;
    p.busy = loadPage(city, n).then(
      (items) => {
        p.busy = null;
        if (pages.current !== p) return false;
        p.next = n + 1;
        setFeed((list) => {
          const ids = new Set((list ?? []).map((v) => v.id));
          return [...(list ?? []), ...items.filter((v) => !ids.has(v.id))];
        });
        return p.next <= p.last;
      },
      () => {
        p.busy = null;
        return false;
      },
    );
    return p.busy;
  }, [city]);
  /** Все страницы: фильтры и «Рядом с домом» должны искать по всему городу. */
  const loadAll = useCallback(async () => {
    while (await loadNext()) {
      /* грузим по одной странице, пока есть */
    }
  }, [loadNext]);
  /** Подгружает файлы выбранных профессий, которых ещё нет. */
  const loadRoles = useCallback(
    (titles: string[] | undefined) => {
      if (!city || !titles?.length) return;
      for (const title of titles) {
        const key = index?.roles?.find((r) => r.title === title)?.key;
        if (!key || extra[title]) continue;
        setExtra((x) => ({ ...x, [title]: x[title] ?? [] }));
        void loadRole(city, key).then((items) => {
          if (extraCity.current === city) setExtra((x) => ({ ...x, [title]: items }));
        });
      }
    },
    [city, index, extra],
  );
  /** Лента вместе с подгруженными вакансиями профессий: свежие из ленты первыми, остальные после. */
  const withExtra = useMemo(() => {
    const all = feed ?? [];
    const lists = Object.values(extra).filter((l) => l.length);
    if (!lists.length) return all;
    const ids = new Set(all.map((v) => v.id));
    const more: Vacancy[] = [];
    for (const v of lists.flat()) {
      if (ids.has(v.id)) continue;
      ids.add(v.id);
      more.push(v);
    }
    more.sort((a, b) => (b.posted_at ?? '').localeCompare(a.posted_at ?? ''));
    return [...all, ...more];
  }, [feed, extra]);

  return { feed, setFeed, extra, setExtra, extraCity, total, setTotal, pages, loadNext, loadAll, loadRoles, withExtra };
}

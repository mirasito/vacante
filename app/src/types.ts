import type { ApplicationPatch, ContactKind, Method } from './server';

export type Lang = 'ru' | 'kk';

export interface Vacancy {
  id: string;
  title: string;
  title_kk?: string;
  category: string;
  employer?: string;
  pay?: string;
  pay_kk?: string;
  monthly?: string;
  monthly_kk?: string;
  schedule?: string;
  perks?: string[];
  perks_kk?: string[];
  address?: string;
  map?: string;
  /** Точка адреса работы: по ней видно, далеко ли от дома. Ставит hh.kz или находит OpenStreetMap. */
  lat?: number;
  lon?: number;
  /** Точка из OpenStreetMap: рядом с расстоянием пишем «© OpenStreetMap» (так требует лицензия ODbL). */
  osm?: boolean;
  /** Точка примерная: адрес не нашёлся точно, она посередине улицы или микрорайона. */
  approx?: boolean;
  posted_at: string;
  top?: boolean;
  url: string;
  source_url?: string;
  text?: string;
  avatar?: string;
  /** Какие контакты есть в исходном посте: по ним окно «Как откликнуться?» показывает кнопки. */
  contact?: ContactKind[];
}

export interface City {
  slug: string;
  name: string;
  name_kk: string;
  count: number;
}

export interface Category {
  slug: string;
  name: string;
  name_kk: string;
}

/** Профессия для анкеты «Кем хочу работать». */
export interface Role {
  title: string;
  title_kk: string;
  category: string;
}

export interface Index {
  updated_at: string;
  cities: City[];
  categories: Category[];
  /** Профессии, частые в вакансиях первыми (с ноября 2026). */
  roles?: Role[];
}

/**
 * Понравившаяся вакансия на телефоне. Без профиля это и есть отклик: стадия, способ и заметка
 * живут только здесь, а с профилем всё переезжает на сервер (server.importApplications).
 */
export interface Liked extends Vacancy, ApplicationPatch {
  city: string;
  liked_at: string;
  method?: Method | null;
  sent_at?: string | null;
}

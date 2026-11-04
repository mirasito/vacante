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
  posted_at: string;
  top?: boolean;
  url: string;
  source_url?: string;
  text?: string;
  avatar?: string;
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

export interface Liked extends Vacancy {
  city: string;
  liked_at: string;
}

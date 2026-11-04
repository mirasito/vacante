// Далеко ли работа от дома: расстояние по прямой между домом из профиля и точкой адреса вакансии.
// Дом приходит только этому человеку с сервера профилей и никуда больше не уходит: считаем здесь.
import type { Lang, Vacancy } from './types';

export interface Point {
  lat: number;
  lon: number;
}

/** Радиусы фильтра «Рядом с домом», км. */
export const NEAR_KM = [3, 5, 10] as const;
export type NearKm = (typeof NEAR_KM)[number];
export const DEFAULT_NEAR: NearKm = 5;
/** Дальше этого расстояние на карточке не пишем: значит, дом в другом городе. */
const SHOW_KM = 50;

export function distanceKm(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Сколько километров от дома до работы, если известны обе точки. */
export function kmFromHome(home: Point | null | undefined, v: Vacancy): number | null {
  if (!home || typeof v.lat !== 'number' || typeof v.lon !== 'number') return null;
  return distanceKm(home, { lat: v.lat, lon: v.lon });
}

/**
 * «2,4 км от дома». Дом округлён до 300–500 метров, поэтому ближе километра пишем «меньше 1 км»,
 * а дальше 10 км — целыми. null, если расстояния нет или дом в другом городе.
 */
export function distanceLabel(km: number | null, lang: Lang): string | null {
  if (km === null || km > SHOW_KM) return null;
  if (km < 1) return lang === 'kk' ? 'Үйден 1 км-ден жақын' : 'Меньше 1 км от дома';
  const n = km < 10 ? (Math.round(km * 10) / 10).toString().replace('.', ',') : String(Math.round(km));
  return lang === 'kk' ? `Үйден ${n} км` : `${n} км от дома`;
}

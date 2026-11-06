// Подбор ленты «Рядом»: что человек выбрал на старте («Кем работаешь», «Где и когда»),
// фильтры из листа «Фильтры» и строка «Почему вам» на карточке. Всё хранится только на телефоне.
import type { Employment, Experience } from './server';
import type { Lang, ShiftKind, Vacancy } from './types';

/** Ответы стартовых экранов. */
export interface Want {
  roles: string[];
  experience: Experience | null;
  employment: Employment[];
}

/** Фильтры ленты. Пустой фильтр ничего не прячет. */
export interface Filter {
  roles?: string[];
  sched?: Sched[];
  payFrom?: number | null;
  noExp?: boolean;
  /** Только смены и подработка (кнопка «Смены» в ленте). */
  shift?: boolean;
}

/** Подпись значка смены на карточке. */
export function shiftLabel(k: ShiftKind, lang: Lang, v?: Vacancy) {
  const kk = lang === 'kk';
  if (k === 'slot' && v?.shift_day) return `⚡ ${(kk ? v.shift_day_kk : null) ?? v.shift_day}, ${v.shift_time ?? ''}`.trim();
  if (k === 'slot') return kk ? '⚡ Бір күндік ауысым' : '⚡ Смена на день';
  if (k === 'part') return kk ? '⚡ Қосымша жұмыс' : '⚡ Подработка';
  if (k === 'hour') return kk ? '⚡ Сағаттық төлем' : '⚡ Почасовая';
  if (k === 'daily') return kk ? '⚡ Күнделікті төлем' : '⚡ Оплата каждый день';
  return kk ? '⚡ Ауысымға төлем' : '⚡ Оплата за смену';
}

export const SCHEDS = ['2/2', '5/2', '6/1', 'night'] as const;
export type Sched = (typeof SCHEDS)[number];
export const PAY_FROM = [150000, 200000, 250000, 300000] as const;

const NIGHT = /ноч|түн/i;
/** Ответы «Где и когда», кому подходят смены и подработка. */
const PART_TIME: Employment[] = ['shifts', 'part', 'weekends', 'flexible'];

export function schedLabel(s: Sched, lang: Lang) {
  if (s === 'night') return lang === 'kk' ? 'Түнгі' : 'Ночные';
  return s;
}

/** Профессии вакансии: в названии они идут через запятую («Официант, Бармен»). */
export const rolesOf = (v: Vacancy) => v.title.split(', ');

export function matches(v: Vacancy, f: Filter): boolean {
  if (f.roles?.length && !rolesOf(v).some((r) => f.roles!.includes(r))) return false;
  if (f.sched?.length) {
    const s = `${v.schedule ?? ''} ${v.text?.slice(0, 200) ?? ''}`;
    const ok = f.sched.some((x) => (x === 'night' ? NIGHT.test(s) : (v.schedule ?? '').includes(x)));
    if (!ok) return false;
  }
  if (f.payFrom && !(v.pay_month && v.pay_month >= f.payFrom)) return false;
  if (f.noExp && !(v.perks ?? []).includes('Без опыта')) return false;
  if (f.shift && !v.shift) return false;
  return true;
}

/** Сколько фильтров включено: число на кнопке «Фильтры». */
export const filterCount = (f: Filter) =>
  (f.roles?.length ? 1 : 0) + (f.sched?.length ? 1 : 0) + (f.payFrom ? 1 : 0) + (f.noExp ? 1 : 0);

/**
 * «Почему вам: ваша профессия, 2 км от дома». Только то, что правда совпало; null, если ничего.
 * km — расстояние от дома или места, где человек нажал «Рядом со мной».
 */
export function why(v: Vacancy, want: Want | undefined, km: number | null, lang: Lang): string | null {
  const kk = lang === 'kk';
  const out: string[] = [];
  if (want?.roles.length && rolesOf(v).some((r) => want.roles.includes(r))) out.push(kk ? 'сіздің мамандығыңыз' : 'ваша профессия');
  if (km !== null && km <= 3) out.push(kk ? 'жақын жерде' : 'рядом');
  if (want?.experience === 'none' && (v.perks ?? []).includes('Без опыта')) out.push(kk ? 'тәжірибесіз болады' : 'можно без опыта');
  if (want?.employment.includes('night') && NIGHT.test(v.schedule ?? '')) out.push(kk ? 'түнгі ауысым' : 'ночные смены');
  else if (v.shift && want?.employment.some((e) => PART_TIME.includes(e)))
    out.push(v.shift === 'part' ? (kk ? 'қосымша жұмыс' : 'подработка') : kk ? 'ауысымдық төлем' : 'оплата за смену');
  if (!out.length) return null;
  return `${kk ? 'Неге сізге' : 'Почему вам'}: ${out.join(', ')}`;
}

/** Ссылка на бота: подписка на новые вакансии по городу, сфере и зарплате (bot/src/logic.js fromLink). */
export const subscribeLink = (
  city: string,
  category: string | null | undefined,
  payFrom: number | null | undefined,
  shift?: boolean,
) => `https://t.me/vacantekz_bot?start=sub_${city}_${category || 'all'}_${payFrom ?? 0}${shift ? '_s' : ''}`;

// Повторные открытия для воронки. До согласия сервер ничего не знает о человеке, поэтому «этот человек
// уже открывал приложение» помнит само устройство: день прошлого открытия лежит только на телефоне,
// а серверу уходит одно число — сколько дней прошло. По нему сервер считает людей за период, не складывая дни.

/** day — день последнего открытия, prev — день открытия перед ним (ГГГГ-ММ-ДД по времени Казахстана). */
export type Opens = { day: string; prev?: string };

/** Дальше сервер не смотрит: период в админке не длиннее 90 дней. */
const MAX_GAP = 90;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** День по времени Казахстана (UTC+5), как его считает сервер. */
export const dayOf = (ms: number) => new Date(ms + 5 * 3_600_000).toISOString().slice(0, 10);

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Что запомнить после открытия сегодня и что сообщить серверу. gap — сколько дней назад было прошлое
 * открытие (1…90); его нет у первого открытия и у открытия после долгого перерыва. Второе открытие
 * за день сообщает то же, что и первое: сервер после перезапуска может посчитать его заново.
 */
export function nextOpen(stored: unknown, today: string): { opens: Opens; gap?: number } {
  const was = stored as Partial<Opens> | null | undefined;
  const valid = (d: unknown): d is string => typeof d === 'string' && DAY.test(d) && d <= today;
  if (!was || typeof was !== 'object' || !valid(was.day)) return { opens: { day: today } };
  const prev = was.day < today ? was.day : valid(was.prev) && was.prev < today ? was.prev : undefined;
  if (!prev) return { opens: { day: today } };
  const gap = daysBetween(prev, today);
  return { opens: { day: today, prev }, ...(gap >= 1 && gap <= MAX_GAP ? { gap } : {}) };
}

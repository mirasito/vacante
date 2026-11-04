// Время Казахстана: с 1 марта 2024 года вся страна живёт по UTC+5 круглый год, без летнего времени.
// Поэтому сдвиг постоянный и не зависит от того, какая база часовых поясов стоит на сервере.
import type { Lang } from "./labels.ts";

export const OFFSET_MS = 5 * 60 * 60_000;
const DAY_MS = 86_400_000;

const local = (ms: number) => new Date(ms + OFFSET_MS);

/** День по времени Казахстана, ГГГГ-ММ-ДД. */
export const localDay = (ms: number) => local(ms).toISOString().slice(0, 10);

/** Час по времени Казахстана, 0–23. */
export const localHour = (ms: number) => local(ms).getUTCHours();

/** Начало недели: понедельник 00:00 по времени Казахстана. */
export function weekStart(ms: number): number {
  const d = local(ms);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday) - OFFSET_MS;
}

/** «2026-11-05T15:00» из поля datetime-local (время Казахстана) → миллисекунды UTC. */
export function fromLocal(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi) - OFFSET_MS;
  const back = local(ms);
  // 31 ноября и 25:00 не пропускаем
  if (back.getUTCDate() !== d || back.getUTCHours() !== h || back.getUTCMonth() !== mo - 1) return null;
  return ms;
}

/** Значение для поля datetime-local: миллисекунды UTC → «2026-11-05T15:00» по времени Казахстана. */
export const toLocalInput = (ms: number) => local(ms).toISOString().slice(0, 16);

export const isValidDay = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
};

const MONTHS: Record<Lang, string[]> = {
  ru: ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"],
  kk: ["қаңтар", "ақпан", "наурыз", "сәуір", "мамыр", "маусым", "шілде", "тамыз", "қыркүйек", "қазан", "қараша", "желтоқсан"],
};

/** «5 ноября в 15:00» или «5 қараша, 15:00». */
export function dateTimeLabel(ms: number, lang: Lang): string {
  const d = local(ms);
  const day = `${d.getUTCDate()} ${MONTHS[lang][d.getUTCMonth()]}`;
  const time = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return lang === "kk" ? `${day}, ${time}` : `${day} в ${time}`;
}

/** Тихие часы бота: с 21:00 до 9:00 сообщения приходят без звука. */
export const quietHours = (ms: number) => {
  const h = localHour(ms);
  return h >= 21 || h < 9;
};

export { DAY_MS };

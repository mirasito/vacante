// Ограничения частоты: только в памяти сервера, ничего не записывается.
import { localDay } from "./time.ts";

/**
 * Не больше limit разных значений за день (время Казахстана): счётчики, у которых значение приходит
 * в запросе, не раздуваются выдуманными метками и id. Со сменой дня список начинается заново.
 * known — свои значения: им место в пределе есть всегда, выдуманные их не вытеснят.
 */
export class DayCap {
  private day = "";
  private seen = new Set<string>();
  private readonly limit: number;
  private readonly known: readonly string[];
  constructor(limit: number, known: readonly string[] = []) {
    this.limit = limit;
    this.known = known;
  }
  /** true — значение сегодня уже было или ещё помещается в дневной предел. */
  take(value: string, now: number): boolean {
    const day = localDay(now);
    if (day !== this.day) {
      this.day = day;
      this.seen = new Set(this.known);
    }
    if (this.seen.has(value)) return true;
    if (this.seen.size >= this.limit) return false;
    this.seen.add(value);
    return true;
  }
}

/** Сколько ключей держим, прежде чем убрать те, чьё окно уже кончилось. */
const PRUNE_AT = 10_000;
/** Больше стольких ключей с живым окном не держим: память важнее счётчиков. */
const HARD_CAP = 200_000;

/** Не больше limit очков за windowMs с одного ключа (адрес, пользователь). */
export class RateLimit {
  private hits = new Map<string, { start: number; points: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private pruneAt = PRUNE_AT;
  constructor(limit = 60, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  take(key: string, now: number, points = 1): boolean {
    const hit = this.hits.get(key);
    if (!hit || now - hit.start >= this.windowMs) {
      // Раньше при 10 000 ключей карта очищалась целиком, и вместе с мусором пропадали
      // заблокированные адреса: 10 000 запросов с разных адресов снимали блокировку подбора
      // пароля. Теперь убираем только записи с кончившимся окном, а следующую чистку
      // откладываем, пока карта снова не вырастет вдвое, чтобы не перебирать её на каждом запросе.
      if (this.hits.size >= this.pruneAt) {
        for (const [k, h] of this.hits) if (now - h.start >= this.windowMs) this.hits.delete(k);
        if (this.hits.size > HARD_CAP) this.hits.clear();
        this.pruneAt = Math.max(PRUNE_AT, this.hits.size * 2);
      }
      this.hits.set(key, { start: now, points });
      return points <= this.limit;
    }
    hit.points += points;
    return hit.points <= this.limit;
  }
}

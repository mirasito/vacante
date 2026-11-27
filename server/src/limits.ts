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

/** Не больше limit очков за windowMs с одного ключа (адрес, пользователь). */
export class RateLimit {
  private hits = new Map<string, { start: number; points: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit = 60, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  take(key: string, now: number, points = 1): boolean {
    const hit = this.hits.get(key);
    if (!hit || now - hit.start >= this.windowMs) {
      if (this.hits.size > 10_000) this.hits.clear();
      this.hits.set(key, { start: now, points });
      return points <= this.limit;
    }
    hit.points += points;
    return hit.points <= this.limit;
  }
}

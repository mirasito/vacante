// Ограничения частоты: только в памяти сервера, ничего не записывается.

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

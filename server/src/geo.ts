// Где живёт соискатель: точка, определённая телефоном, или дом, найденный в 2ГИС по ссылке.
// Храним точку округлённой до 0,005° (300–500 метров): по ней видно, далеко ли ехать до работы,
// но не видно дом. Адрес не храним, работодатель точку не видит.

export type HomeSource = "phone" | "2gis";
export const HOME_SOURCES: readonly HomeSource[] = ["phone", "2gis"];

export interface Point {
  lat: number;
  lon: number;
}

/** Казахстан с запасом: точка за его пределами — ошибка в ссылке или телефон не дома. */
const KZ = { minLat: 40.5, maxLat: 55.5, minLon: 46.4, maxLon: 87.4 };

export const inKazakhstan = ({ lat, lon }: Point) =>
  lat >= KZ.minLat && lat <= KZ.maxLat && lon >= KZ.minLon && lon <= KZ.maxLon;

/** 43.23891 → 43.24: шаг 0,005°, то есть 550 метров с севера на юг и около 400 с запада на восток. */
export const roundHome = (value: number) => Math.round(value * 200) / 200;

/** Расстояние по прямой в километрах. */
export function distanceKm(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Сайты 2ГИС в Казахстане и России, короткие ссылки «Поделиться» и картинки превью
const HOST = /^(?:www\.|go\.|share\.api\.)?2gis\.(?:kz|ru|com)$/i;
const NUMBER = String.raw`-?\d{1,3}(?:\.\d+)?`;
const LON_LAT = new RegExp(`^(${NUMBER}),(${NUMBER})$`);
const LON_LAT_ZOOM = new RegExp(`^(${NUMBER}),(${NUMBER})(?:/[\\d.]+)?$`);

export const is2gis = (url: URL) => url.protocol === "https:" && HOST.test(url.hostname) && !url.username && !url.port;

/** Первая ссылка 2ГИС в тексте: приложение 2ГИС делится строкой «Адрес, город https://go.2gis.com/…». */
export function find2gisLink(text: string): URL | null {
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    let url: URL;
    try {
      url = new URL(match[0].replace(/^http:/i, "https:"));
    } catch {
      continue;
    }
    if (is2gis(url)) return url;
  }
  return null;
}

const toPoint = (m: RegExpExecArray | null): Point | null => {
  if (!m) return null;
  const point = { lon: Number(m[1]), lat: Number(m[2]) };
  return Number.isFinite(point.lat) && Number.isFinite(point.lon) && inKazakhstan(point) ? point : null;
};

/**
 * Точка прямо из адреса, без запроса в 2ГИС. Варианты, которые даёт 2ГИС:
 * …/geo/76.912345%2C43.245678 и …/firm/7000…/76.9,43.2 — точка в пути;
 * ?m=76.9%2C43.2%2F17 — центр карты; share.api.2gis.ru/getimage?…&center=76.9%2C43.2 — превью.
 */
export function pointFrom2gisUrl(url: URL): Point | null {
  for (const part of url.pathname.split("/")) {
    const point = toPoint(LON_LAT.exec(part.replace(/%2C/gi, ",")));
    if (point) return point;
  }
  return toPoint(LON_LAT.exec(url.searchParams.get("center") ?? "")) ?? toPoint(LON_LAT_ZOOM.exec(url.searchParams.get("m") ?? ""));
}

/** Подпись картинки превью: «Music Store» и «Улица Мукими, 98а<br />Ташкент» → «Music Store, Улица Мукими, 98а, Ташкент». */
function labelFrom(url: URL): string | null {
  const parts = [url.searchParams.get("title"), url.searchParams.get("desc")]
    .map((v) => (v ?? "").replace(/<br\s*\/?>/gi, ", ").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const label = [...new Set(parts)].join(", ");
  return label ? label.slice(0, 120) : null;
}

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** Картинка превью на странице 2ГИС: в ней точка дома и подпись с адресом. */
export function previewFromHtml(html: string): URL | null {
  const re = /<meta\s+[^>]*(?:property|name)="(?:twitter:image|og:image)"[^>]*>/gi;
  for (const tag of html.match(re) ?? []) {
    const content = /content="([^"]+)"/i.exec(tag)?.[1];
    if (!content) continue;
    try {
      const url = new URL(decodeEntities(content));
      if (is2gis(url) && pointFrom2gisUrl(url)) return url;
    } catch {
      // следующая
    }
  }
  return null;
}

const MAX_HTML = 2 * 1024 * 1024;

async function readText(res: Response, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size >= limit) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface Found extends Point {
  /** Адрес, как его подписал 2ГИС: только чтобы человек проверил, что нашли его дом. Не храним. */
  label: string | null;
}

/**
 * Дом по ссылке 2ГИС. Сначала ищем точку в самой ссылке, иначе открываем её, как это делает
 * превью ссылок в мессенджерах: короткая ссылка ведёт на страницу дома, а на странице есть
 * картинка превью с точкой. Ходим только на сайты 2ГИС, не дальше пяти переходов.
 * null, если точки не нашлось или она не в Казахстане.
 */
export async function resolve2gis(fetchFn: typeof fetch, text: string): Promise<Found | null> {
  let url = find2gisLink(text);
  for (let hop = 0; url && hop < 5; hop++) {
    const point = pointFrom2gisUrl(url);
    if (point) return { ...point, label: labelFrom(url) };
    const res = await fetchFn(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "VacanteBot/1.0 (+https://vacante.kz)", Accept: "text/html" },
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get("location");
      const next = location ? new URL(location, url) : null;
      url = next && is2gis(next) ? next : null;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const preview = previewFromHtml(await readText(res, MAX_HTML));
    const found = preview && pointFrom2gisUrl(preview);
    return found ? { ...found, label: labelFrom(preview) } : null;
  }
  return null;
}

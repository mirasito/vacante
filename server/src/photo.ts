// Фото в профиле. Приложение уменьшает снимок на телефоне и присылает JPEG, а сервер ещё раз
// оставляет в файле только саму картинку: EXIF (место съёмки, модель телефона, дата), XMP,
// миниатюры, комментарии и всё, что дописано после конца картинки, выбрасывается.

/**
 * Приложение присылает 100–400 КБ: снимок до 1280 точек по длинной стороне. Больше мегабайта
 * не пропустит и Caddy (request_body max_size 1MB в server/deploy/Caddyfile).
 */
export const MAX_PHOTO_BYTES = 1_000_000;
export const MIN_PHOTO_SIDE = 100;
export const MAX_PHOTO_SIDE = 2560;

export interface CleanPhoto {
  data: Buffer;
  width: number;
  height: number;
}

// Кадр JPEG, который показывают все браузеры: базовый, расширенный и прогрессивный
const FRAMES = new Set([0xc0, 0xc1, 0xc2]);
// Прочие кадры (без потерь, арифметическое кодирование): браузеры их не показывают
const OTHER_FRAMES = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const isApp = (marker: number) => marker >= 0xe0 && marker <= 0xef;
const isRst = (marker: number) => marker >= 0xd0 && marker <= 0xd7;

/**
 * Чистый JPEG без метаданных или null, если это не JPEG, его не дочитать или размер не подходит.
 * Сегменты APP0–APP15 (JFIF, EXIF, XMP, ICC, Photoshop) и COM выбрасываются, остальное
 * копируется как есть, включая сжатые данные между маркерами.
 */
export function cleanJpeg(input: Buffer): CleanPhoto | null {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return null;
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let i = 2;
  let width = 0;
  let height = 0;
  let frames = 0;
  let scans = 0;
  while (i < input.length) {
    if (input[i] !== 0xff) return null;
    // Перед маркером может стоять сколько угодно байтов-заполнителей 0xFF
    while (i < input.length && input[i] === 0xff) i++;
    if (i >= input.length) return null;
    const marker = input[i]!;
    i++;
    if (marker === 0xd9) {
      // Конец картинки: всё, что дописано после него, не копируем
      if (!frames || !scans) return null;
      out.push(Buffer.from([0xff, 0xd9]));
      if (width < MIN_PHOTO_SIDE || height < MIN_PHOTO_SIDE || width > MAX_PHOTO_SIDE || height > MAX_PHOTO_SIDE) return null;
      return { data: Buffer.concat(out), width, height };
    }
    if (marker === 0x00 || marker === 0xd8 || isRst(marker) || marker === 0x01) return null;
    if (i + 2 > input.length) return null;
    const length = input.readUInt16BE(i);
    if (length < 2 || i + length > input.length) return null;
    const segment = input.subarray(i - 2, i + length);
    const start = i;
    i += length;
    if (isApp(marker) || marker === 0xfe) continue;
    if (OTHER_FRAMES.has(marker)) return null;
    if (FRAMES.has(marker)) {
      // P, высота, ширина, число каналов: 1 (серое) или 3 (цветное)
      if (frames++ || length < 8) return null;
      height = input.readUInt16BE(start + 3);
      width = input.readUInt16BE(start + 5);
      const channels = input[start + 7];
      if (channels !== 1 && channels !== 3) return null;
    }
    if (marker === 0xda && !frames) return null;
    out.push(segment);
    if (marker !== 0xda) continue;
    // После заголовка скана идут сжатые данные до следующего маркера. Внутри них 0xFF
    // встречается только как FF 00 (байт данных) или FF D0–D7 (метка перезапуска)
    scans++;
    let j = i;
    while (j < input.length) {
      if (input[j] === 0xff && j + 1 < input.length) {
        const next = input[j + 1]!;
        if (next === 0x00 || isRst(next)) {
          j += 2;
          continue;
        }
        break;
      }
      j++;
    }
    if (j >= input.length) return null;
    out.push(input.subarray(i, j));
    i = j;
  }
  return null;
}

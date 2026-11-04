// Фото в профиль: выбрать снимок на телефоне и уменьшить его до 1280 точек по длинной стороне.
// Картинка перерисовывается заново, поэтому в файл, который уходит на сервер, не попадают
// EXIF с местом съёмки и моделью телефона (сервер на всякий случай вычищает их ещё раз).
import { Platform } from 'react-native';

const MAX_SIDE = 1280;
/** Сервер принимает до 1 МБ: если снимок вышел больше, сжимаем сильнее и уменьшаем. */
const MAX_BYTES = 900_000;
const TRIES: [side: number, quality: number][] = [
  [MAX_SIDE, 0.85],
  [MAX_SIDE, 0.7],
  [960, 0.7],
];

export const canPickPhoto = () => Platform.OS === 'web' && typeof document !== 'undefined';

/**
 * Окно выбора фото: галерея или камера. Вызывать прямо в обработчике нажатия, иначе телефон
 * окно не откроет. null, если человек ничего не выбрал (тогда обещание может и не завершиться).
 */
export function pickPhoto(): Promise<File | null> {
  if (!canPickPhoto()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.position = 'fixed';
    input.style.left = '-1000px';
    input.style.opacity = '0';
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}

/** Снимок, уменьшенный и перерисованный в JPEG. null, если телефон не смог его открыть (например, HEIC на Android). */
export async function shrinkPhoto(file: Blob): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    let blob: Blob | null = null;
    for (const [side, quality] of TRIES) {
      blob = await draw(img, side, quality);
      if (!blob || blob.size <= MAX_BYTES) break;
    }
    return blob && blob.size <= MAX_BYTES ? blob : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function draw(img: HTMLImageElement, side: number, quality: number): Promise<Blob | null> {
  // Браузеры поворачивают снимок по EXIF сами: naturalWidth и drawImage уже с поворотом
  const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  // Белый фон: у PNG с прозрачностью в JPEG иначе вышел бы чёрный
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

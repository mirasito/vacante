// Кружки соискателей: файлы в папке videos на сервере в Казахстане и отдача по кускам (Range),
// чтобы браузер работодателя мог перематывать и не качал весь файл сразу.
import { renameSync, statSync, writeFileSync } from "node:fs";

import { HttpError, type Reply, type Request } from "./http.ts";

/** Бот может скачать из Telegram файл не больше 20 МБ, кружок до минуты обычно 2–8 МБ. */
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
export const MAX_POSTER_BYTES = 512 * 1024;
/** Telegram записывает кружок не длиннее минуты. */
export const MAX_DURATION = 60;

/** Запись через временный файл: оборванная запись не оставит половину кружка под настоящим именем. */
export function writeAtomic(path: string, data: Buffer) {
  const tmp = `${path}.part`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Файл целиком или кусок из заголовка Range: bytes=start-end. */
export function fileReply(req: Request, path: string, contentType: string): Reply {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new HttpError(404, "Нет файла");
  }
  const headers = { "Content-Type": contentType, "Accept-Ranges": "bytes" };
  const range = req.header("range")?.trim();
  if (!range) return { headers, file: { path, start: 0, end: size - 1 } };
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  let start = NaN;
  let end = NaN;
  if (m && m[1] !== "") {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  } else if (m && m[2] !== "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  }
  if (!(start <= end) || start >= size) {
    return { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` }, body: Buffer.alloc(0) };
  }
  return { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}` }, file: { path, start, end } };
}

/** 42 → «0:42». */
export const duration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

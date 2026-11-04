import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { cleanJpeg } from "../src/photo.ts";
import { BROWSER, initDataFor, startServer, type TestServer } from "./helpers.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
// Снимок 240×320 с EXIF как у телефона: марка, модель, дата и место съёмки, плюс комментарий
const PHOTO = fixture("photo-exif.jpg");
const PROGRESSIVE = fixture("photo-progressive.jpg");

const ANKETA = {
  name: "Дана",
  city: "almaty",
  roles: ["Кассир"],
  experience: "lt1",
  employment: ["full"],
  start: "today",
};
const CONSENT = { version: "2026-11-04.2", adult: true, base: false };
const DANA = { id: 7301, first_name: "Дана", language_code: "ru" };
const auth = (user: Record<string, unknown> = DANA) => ({ authorization: `tma ${initDataFor(user)}` });
const jpeg = (user: Record<string, unknown> = DANA) => ({ ...auth(user), "content-type": "image/jpeg" });

let s: TestServer;
before(async () => {
  s = await startServer();
});
after(() => s.close());

const files = () => (existsSync(s.config.videosDir) ? readdirSync(s.config.videosDir).sort() : []);

/** Маркеры сегментов до первого скана: FF E1 (EXIF), FF FE (комментарий) и т.д. */
function headerMarkers(data: Buffer): number[] {
  const markers: number[] = [];
  let i = 2;
  while (i + 4 <= data.length && data[i] === 0xff) {
    const marker = data[i + 1]!;
    markers.push(marker);
    if (marker === 0xda) break;
    i += 2 + data.readUInt16BE(i + 2);
  }
  return markers;
}

test("из фото уходят EXIF, место съёмки, комментарий и всё, что после конца картинки", () => {
  assert.ok(PHOTO.includes("Exif") && PHOTO.includes("Galaxy A54") && PHOTO.includes("secret comment"));
  const clean = cleanJpeg(Buffer.concat([PHOTO, Buffer.from("<html><script>alert(1)</script>")]));
  assert.ok(clean);
  assert.equal(clean.width, 240);
  assert.equal(clean.height, 320);
  assert.deepEqual([...clean.data.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...clean.data.subarray(-2)], [0xff, 0xd9]);
  for (const text of ["Exif", "Galaxy", "Samsung", "secret", "<html", "JFIF"]) assert.ok(!clean.data.includes(text), text);
  const markers = headerMarkers(clean.data);
  assert.ok(markers.includes(0xdb) && markers.includes(0xc0) && markers.at(-1) === 0xda, markers.join(","));
  assert.ok(!markers.some((m) => (m >= 0xe0 && m <= 0xef) || m === 0xfe));
  // Сжатые данные не тронуты: файл короче ровно на выброшенное
  assert.ok(clean.data.length < PHOTO.length && clean.data.length > PHOTO.length - 1000);
  // Чистый файл чистится в себя же
  assert.deepEqual(cleanJpeg(clean.data)?.data, clean.data);
});

test("прогрессивный JPEG сохраняет все сканы", () => {
  const clean = cleanJpeg(PROGRESSIVE);
  assert.ok(clean);
  assert.equal(clean.width, 240);
  assert.ok(!clean.data.includes("Exif"));
  let scans = 0;
  for (let i = clean.data.indexOf(0xff); i >= 0 && i < clean.data.length - 1; i = clean.data.indexOf(0xff, i + 1)) {
    if (clean.data[i + 1] === 0xda) scans++;
  }
  assert.ok(scans > 2, `сканов ${scans}`);
});

test("не фото, обрезанное фото и слишком маленькое фото не принимаются", () => {
  assert.equal(cleanJpeg(Buffer.from("\x89PNG\r\n\x1a\n0000")), null);
  assert.equal(cleanJpeg(Buffer.from("<html></html>")), null);
  assert.equal(cleanJpeg(PHOTO.subarray(0, PHOTO.length - 200)), null);
  assert.equal(cleanJpeg(PHOTO.subarray(0, 600)), null);
  assert.equal(cleanJpeg(fixture("photo-small.jpg")), null); // 80×60
  assert.equal(cleanJpeg(Buffer.alloc(0)), null);
});

test("фото в профиле: загрузить, показать работодателю, заменить, удалить", async () => {
  const before = await s.call("PUT", "/me/photo", { headers: jpeg(), body: PHOTO });
  assert.equal(before.status, 404); // профиля ещё нет

  const created = await s.call("PUT", "/me/profile", {
    headers: { ...auth(), "x-vacante-beta": "1" },
    body: { consent: CONSENT, profile: ANKETA, lang: "ru" },
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.photo, null);
  assert.deepEqual(created.json.strength, { percent: 45, next: "video" });

  const up = await s.call("PUT", "/me/photo", { headers: jpeg(), body: PHOTO });
  assert.equal(up.status, 200, up.text);
  assert.deepEqual(up.json.photo, { width: 240, height: 320, uploaded_at: "2026-11-04T06:00:00Z" });
  assert.equal(up.json.strength.percent, 55);
  const [first] = files();
  assert.match(first!, /^7301-[a-z2-9]{8}-photo\.jpg$/);
  assert.ok(!readFileSync(`${s.config.videosDir}/${first}`).includes("Exif"));

  // Своё фото в приложении
  const mine = await s.call("GET", "/me/photo", { headers: auth() });
  assert.equal(mine.status, 200);
  assert.equal(mine.headers["content-type"], "image/jpeg");
  assert.ok(!mine.body.includes("Galaxy"));
  assert.equal((await s.call("GET", "/me/photo", { headers: auth({ id: 7399, first_name: "Чужой" }) })).status, 404);

  // Работодатель видит фото вместо букв имени
  const { code } = (await s.call("POST", "/me/link", { headers: auth() })).json;
  const page = await s.call("GET", `/${code}`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER } });
  assert.match(page.text, new RegExp(`<img src="/${code}/photo.jpg" alt="Дана">`));
  const shown = await s.call("GET", `/${code}/photo.jpg`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER } });
  assert.equal(shown.status, 200);
  assert.equal(shown.headers["content-type"], "image/jpeg");
  assert.equal(shown.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(shown.body, mine.body);
  // Превью ссылки фото не показывает
  const preview = await s.call("GET", `/${code}`, { host: "p.vacante.kz", headers: { "user-agent": "WhatsApp/2.24.1 A" } });
  assert.doesNotMatch(preview.text, /photo\.jpg|Дана/);

  // Новое фото заменяет прежнее, старый файл стирается
  const again = await s.call("PUT", "/me/photo", { headers: jpeg(), body: PROGRESSIVE });
  assert.equal(again.status, 200);
  assert.equal(files().length, 1);
  assert.notEqual(files()[0], first);

  // Не JPEG и слишком большой файл
  const png = await s.call("PUT", "/me/photo", { headers: jpeg(), body: Buffer.from("\x89PNG\r\n\x1a\n") });
  assert.equal(png.status, 400);
  assert.match(png.json.error, /JPEG/);
  const huge = await s.call("PUT", "/me/photo", { headers: jpeg(), body: Buffer.alloc(2 * 1024 * 1024, 0xff) });
  assert.equal(huge.status, 413);
  assert.equal(files().length, 1);

  // Удалить фото: на странице снова буквы, файла нет
  const dropped = await s.call("DELETE", "/me/photo", { headers: auth() });
  assert.equal(dropped.json.photo, null);
  assert.deepEqual(files(), []);
  const plain = await s.call("GET", `/${code}`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER } });
  assert.doesNotMatch(plain.text, /photo\.jpg/);
  assert.match(plain.text, /class="avatar" aria-hidden="true">Д</);
  assert.equal((await s.call("GET", `/${code}/photo.jpg`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER } })).status, 404);
});

test("удаление профиля стирает и фото", async () => {
  const user = { id: 7302, first_name: "Ерлан", language_code: "kk" };
  const created = await s.call("PUT", "/me/profile", {
    headers: { ...auth(user), "x-vacante-beta": "1" },
    body: { consent: CONSENT, profile: { ...ANKETA, name: "Ерлан" }, lang: "kk" },
  });
  assert.equal(created.status, 201);
  assert.equal((await s.call("PUT", "/me/photo", { headers: jpeg(user), body: PHOTO })).status, 200);
  assert.equal(files().filter((f) => f.startsWith("7302-")).length, 1);
  assert.equal((await s.call("DELETE", "/me", { headers: auth(user) })).status, 200);
  assert.deepEqual(files().filter((f) => f.startsWith("7302-")), []);
  assert.equal(Number((s.db.prepare("SELECT COUNT(*) AS n FROM photos").get() as { n: number }).n), 0);
});

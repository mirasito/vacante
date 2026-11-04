import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { putVideo } from "../src/seekers.ts";
import { internalKey } from "../src/telegram.ts";
import { BROWSER, count, initDataFor, NOW, startServer, TOKEN, type TestServer } from "./helpers.ts";

const ANKETA = {
  name: "Ерлан",
  city: "astana",
  district: null,
  roles: ["Повар"],
  experience: "lt1",
  employment: ["shifts"],
  pay_from: null,
  pay_period: null,
  start: "today",
  languages: [],
};
const CONSENT = { version: "2026-11-04.2", adult: true, base: false };

let s: TestServer;
before(async () => {
  s = await startServer();
});
after(() => s.close());

const auth = (user: Record<string, unknown>) => ({ authorization: `tma ${initDataFor(user)}` });
const relay = async (update: unknown) =>
  s.call("POST", "/internal/telegram", { headers: { authorization: `Bearer ${internalKey(TOKEN)}` }, body: update });

async function createProfile(user: { id: number; first_name: string }, lang = "ru") {
  const r = await s.call("PUT", "/me/profile", {
    headers: { ...auth(user), "x-vacante-beta": "1" },
    body: { consent: CONSENT, profile: { ...ANKETA, name: user.first_name }, lang },
  });
  assert.equal(r.status, 201, r.text);
}

const note = (user: { id: number; first_name: string }, fileId: string, unique: string, extra: Record<string, unknown> = {}) => ({
  update_id: 1,
  message: {
    message_id: 20,
    date: NOW / 1000,
    from: user,
    chat: { id: user.id, type: "private" },
    video_note: {
      file_id: fileId,
      file_unique_id: unique,
      duration: 42,
      length: 384,
      file_size: 1000,
      thumbnail: { file_id: `${fileId}-thumb`, file_unique_id: `${unique}t`, width: 320, height: 320 },
    },
    ...extra,
  },
});

const bytes = (n: number, seed: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + seed) % 256));
const videoFiles = () => (existsSync(s.config.videosDir) ? readdirSync(s.config.videosDir).sort() : []);
const lastSent = () => s.sent.filter((m) => m.method === "sendMessage").at(-1)?.body as Record<string, any>;

test("кружок из бота: скачивается в профиль, работодатель смотрит его по ссылке", async () => {
  const user = { id: 8001, first_name: "Ерлан" };
  await createProfile(user);
  const video = bytes(1000, 1);
  const poster = bytes(300, 9);
  s.files.set("vn1", video);
  s.files.set("vn1-thumb", poster);

  const r = await relay(note(user, "vn1", "AgAD1"));
  assert.equal(r.json.handled, true);
  await s.idle();

  const row = s.db.prepare("SELECT file, poster, duration, size, recorded_at FROM videos WHERE seeker_id = ?").get(user.id) as any;
  assert.equal(row.duration, 42);
  assert.equal(row.size, 1000);
  assert.equal(row.recorded_at, "2026-11-04T06:00:00Z");
  assert.deepEqual(videoFiles(), [row.file, row.poster].sort());
  const saved = lastSent();
  assert.match(saved.text, /Кружок в профиле/);
  assert.equal(saved.reply_markup.inline_keyboard[0][0].callback_data, "v:del:AgAD1");
  // Город из профиля: на новом устройстве приложение не спросит его заново
  assert.equal(saved.reply_markup.inline_keyboard[1][0].web_app.url, "https://vacante.kz/app/?tab=profile&city=astana");

  // Сила профиля: анкета 45 + кружок 25
  const view = (await s.call("GET", "/me/profile", { headers: auth(user) })).json;
  assert.deepEqual(view.video, { duration: 42, recorded_at: "2026-11-04T06:00:00Z", ready: true, poster: true });
  assert.equal(view.strength.percent, 70);

  // Своё видео в приложении
  const mine = await s.call("GET", "/me/video", { headers: auth(user) });
  assert.equal(mine.status, 200);
  assert.equal(mine.headers["content-type"], "video/mp4");
  assert.deepEqual(mine.body, video);
  assert.deepEqual((await s.call("GET", "/me/video/poster", { headers: auth(user) })).body, poster);

  // Страница профиля: кружок с обложкой, открывается встроенным плеером
  const { code } = (await s.call("POST", "/me/link", { headers: auth(user) })).json;
  const page = await s.call("GET", `/${code}`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER, "x-forwarded-for": "198.51.100.1" } });
  assert.match(page.text, new RegExp(`<a class="circle" href="/${code}/video.mp4"><img src="/${code}/poster.jpg" alt="">`));
  assert.match(page.text, /▶ Смотреть кружок · 0:42/);

  const p = (path: string, headers: Record<string, string> = {}, method = "GET") =>
    s.call(method, `/${code}${path}`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER, "x-forwarded-for": "198.51.100.1", ...headers } });
  const full = await p("/video.mp4");
  assert.equal(full.status, 200);
  assert.equal(full.headers["accept-ranges"], "bytes");
  assert.deepEqual(full.body, video);
  const part = await p("/video.mp4", { range: "bytes=100-199" });
  assert.equal(part.status, 206);
  assert.equal(part.headers["content-range"], "bytes 100-199/1000");
  assert.deepEqual(part.body, video.subarray(100, 200));
  assert.deepEqual((await p("/video.mp4", { range: "bytes=-10" })).body, video.subarray(990));
  assert.deepEqual((await p("/video.mp4", { range: "bytes=995-" })).body, video.subarray(995));
  const beyond = await p("/video.mp4", { range: "bytes=2000-" });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers["content-range"], "bytes */1000");
  const head = await p("/video.mp4", {}, "HEAD");
  assert.equal(head.headers["content-length"], "1000");
  assert.equal(head.body.length, 0);
  assert.deepEqual((await p("/poster.jpg")).body, poster);
  // Файлы просмотрами не считаются: только сама страница
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM views WHERE seeker_id = ?", user.id), 1);

  // Новый кружок заменяет прежний, файлы прежнего удаляются
  s.files.set("vn2", bytes(800, 2));
  s.files.set("vn2-thumb", bytes(200, 3));
  await relay(note(user, "vn2", "AgAD2", { date: NOW / 1000 + 60 }));
  await s.idle();
  const second = s.db.prepare("SELECT file, poster, size FROM videos WHERE seeker_id = ?").get(user.id) as any;
  assert.equal(second.size, 800);
  assert.deepEqual(videoFiles(), [second.file, second.poster].sort());

  // Кнопка под старым сообщением не трогает новый кружок
  s.sent.length = 0;
  const stale = await relay({ callback_query: { id: "q1", from: user, data: "v:del:AgAD1", message: { message_id: 21, chat: { id: user.id, type: "private" } } } });
  assert.equal(stale.json.handled, true);
  assert.match(String(s.sent[0]?.body.text), /уже заменён/);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM videos WHERE seeker_id = ?", user.id), 1);

  // «Убрать из профиля» под свежим сообщением
  await relay({ callback_query: { id: "q2", from: user, data: "v:del:AgAD2", message: { message_id: 22, chat: { id: user.id, type: "private" } } } });
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM videos WHERE seeker_id = ?", user.id), 0);
  assert.deepEqual(videoFiles(), []);
  assert.ok(s.sent.some((m) => m.method === "answerCallbackQuery" && /убран/.test(String(m.body.text))));
  assert.ok(s.sent.some((m) => m.method === "editMessageText" && m.body.message_id === 22));
  assert.equal((await p("/video.mp4")).status, 404);
  const after = await s.call("GET", `/${code}`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER, "x-forwarded-for": "198.51.100.1" } });
  assert.doesNotMatch(after.text, /class="circle"/);
});

test("кружок без профиля, слишком длинный, обычное видео и /start video", async () => {
  const stranger = { id: 8100, first_name: "Гость" };
  s.sent.length = 0;
  assert.equal((await relay(note(stranger, "x1", "AgX1"))).json.handled, true);
  assert.match(lastSent().text, /Сначала создайте профиль/);
  assert.equal(lastSent().reply_markup.inline_keyboard[0][0].web_app.url, "https://vacante.kz/app/?tab=profile");
  await s.idle();
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM seekers WHERE id = ?", stranger.id), 0);

  const user = { id: 8101, first_name: "Дана" };
  await createProfile(user);
  const long = note(user, "x2", "AgX2");
  long.message.video_note.duration = 75;
  await relay(long);
  assert.match(lastSent().text, /не длиннее минуты/);

  const plain = (from: { id: number; first_name: string }) => ({
    message: { message_id: 30, from, chat: { id: from.id, type: "private" }, video: { file_id: "v", duration: 20 } },
  });
  assert.equal((await relay(plain(user))).json.handled, true);
  assert.match(lastSent().text, /Нужен именно кружок/);
  // Без профиля обычное видео остаётся боту
  const sentBefore = s.sent.length;
  assert.equal((await relay(plain(stranger))).json.handled, false);
  assert.equal(s.sent.length, sentBefore);

  const start = await relay({ message: { message_id: 31, from: user, chat: { id: user.id, type: "private" }, text: "/start video" } });
  assert.equal(start.json.handled, true);
  assert.match(lastSent().text, /Запишите кружок для профиля/);
  // Остальные команды бот ведёт сам
  assert.equal((await relay({ message: { message_id: 32, from: user, chat: { id: user.id, type: "private" }, text: "/start" } })).json.handled, false);

  // По-казахски, если профиль на казахском
  const aruzhan = { id: 8102, first_name: "Аружан" };
  await createProfile(aruzhan, "kk");
  await relay({ message: { message_id: 33, from: aruzhan, chat: { id: aruzhan.id, type: "private" }, text: "/start video" } });
  assert.match(lastSent().text, /бейнехабар жазыңыз/);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM videos"), 0);
});

test("кружок не скачался: человеку пишем, файлов не остаётся", async () => {
  const user = { id: 8200, first_name: "Асель" };
  await createProfile(user);
  await relay(note(user, "missing", "AgM1"));
  await s.idle();
  assert.match(lastSent().text, /Не получилось сохранить кружок/);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM videos WHERE seeker_id = ?", user.id), 0);
  assert.equal(videoFiles().filter((f) => f.startsWith("8200-")).length, 0);
});

test("превью ссылки по галочке: фото или кадр кружка и «▶ Видео», без имени и просмотров", async () => {
  const user = { id: 8050, first_name: "Ерлан" };
  await createProfile(user);
  s.files.set("pv1", bytes(1000, 5));
  s.files.set("pv1-thumb", bytes(300, 6));
  await relay(note(user, "pv1", "AgPV1"));
  await s.idle();
  const { code } = (await s.call("POST", "/me/link", { headers: auth(user) })).json;
  const robot = { host: "p.vacante.kz", headers: { "user-agent": "TelegramBot (like TwitterBot)" } };
  const preview = async (query = "") => (await s.call("GET", `/${code}${query}`, robot)).text;
  const image = (text: string) => /<meta property="og:image" content="([^"]+)">/.exec(text)?.[1];
  const setPreview = (on: boolean) => s.call("PATCH", "/me", { headers: auth(user), body: { preview: on } });

  // Без галочки, как раньше: ни картинки, ни кружка
  const off = await preview();
  assert.equal(image(off), undefined);
  assert.match(off, /<meta property="og:title" content="Профиль кандидата в Vacante">/);
  assert.doesNotMatch(off, /Видео|poster/);

  // С галочкой: кадр кружка и его длина, а имени и анкеты по-прежнему нет
  assert.equal((await setPreview(true)).json.seeker.preview, true);
  const on = await preview();
  assert.match(on, /<meta property="og:title" content="▶ Видео 0:42 · Профиль кандидата">/);
  assert.match(on, /<meta property="og:description" content="Откройте ссылку, чтобы посмотреть кружок и профиль кандидата.">/);
  assert.match(image(on)!, new RegExp(`^https://p\\.vacante\\.kz/${code}/poster\\.jpg\\?v=[0-9a-z]+$`));
  assert.doesNotMatch(on, /Ерлан|Повар/);
  assert.match(await preview("?lang=kk"), /<meta property="og:title" content="▶ Бейнехабар 0:42 · Үміткер профилі">/);
  // Картинка из превью открывается, а превью и картинка просмотрами не считаются
  const url = new URL(image(on)!);
  const frame = await s.call("GET", url.pathname + url.search, robot);
  assert.equal(frame.status, 200);
  assert.equal(frame.headers["content-type"], "image/jpeg");
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM views WHERE seeker_id = ?", user.id), 0);

  // Есть фото: в превью оно, с размером
  const photo = readFileSync(new URL("./fixtures/photo-exif.jpg", import.meta.url));
  const up = await s.call("PUT", "/me/photo", { headers: { ...auth(user), "content-type": "image/jpeg" }, body: photo });
  assert.equal(up.status, 200, up.text);
  const withPhoto = await preview();
  assert.match(image(withPhoto)!, new RegExp(`/${code}/photo\\.jpg\\?v=[0-9a-z]+$`));
  assert.match(withPhoto, /<meta property="og:image:width" content="240">\n<meta property="og:image:height" content="320">/);
  // Тяжёлое фото из прежнего приложения WhatsApp не покажет: тогда кадр кружка
  s.db.prepare("UPDATE photos SET size = 400000 WHERE seeker_id = ?").run(user.id);
  assert.match(image(await preview())!, /\/poster\.jpg\?v=/);

  // Дата первого включения хранится, пока галочку не сняли
  const at = () => (s.db.prepare("SELECT preview_at AS at FROM seekers WHERE id = ?").get(user.id) as { at: string | null }).at;
  assert.equal(at(), "2026-11-04T06:00:00Z");
  assert.equal((await setPreview(false)).json.seeker.preview, false);
  assert.equal(at(), null);
  assert.equal(image(await preview()), undefined);
});

test("удалить кружок из приложения и вместе с профилем", async () => {
  const user = { id: 8300, first_name: "Марат" };
  await createProfile(user);
  s.files.set("d1", bytes(500, 4));
  await relay(note(user, "d1", "AgD1", { video_note: { file_id: "d1", file_unique_id: "AgD1", duration: 15, file_size: 500 } }));
  await s.idle();
  assert.equal(videoFiles().filter((f) => f.startsWith("8300-")).length, 1); // без обложки
  const r = await s.call("DELETE", "/me/video", { headers: auth(user) });
  assert.equal(r.status, 200);
  assert.equal(r.json.video, null);
  assert.equal(videoFiles().filter((f) => f.startsWith("8300-")).length, 0);
  assert.equal((await s.call("GET", "/me/video", { headers: auth(user) })).status, 404);

  await relay(note(user, "d1", "AgD1", { video_note: { file_id: "d1", file_unique_id: "AgD1", duration: 15, file_size: 500 } }));
  await s.idle();
  assert.equal(videoFiles().filter((f) => f.startsWith("8300-")).length, 1);
  await s.call("DELETE", "/me", { headers: auth(user) });
  assert.equal(videoFiles().filter((f) => f.startsWith("8300-")).length, 0);
});

test("скачанный кружок не нужен: профиль удалили или уже есть кружок новее", async () => {
  const user = { id: 8400, first_name: "Айдос" };
  await createProfile(user);
  const v = (recorded_at: string, file: string) => ({
    file_id: file,
    file_unique_id: file,
    file: `${file}.mp4`,
    poster: null,
    duration: 10,
    size: 1,
    recorded_at,
  });
  assert.deepEqual(putVideo(s.db, user.id, v("2026-11-04T06:05:00Z", "new")), []);
  assert.equal(putVideo(s.db, user.id, v("2026-11-04T06:01:00Z", "old")), null);
  assert.deepEqual(putVideo(s.db, user.id, v("2026-11-04T06:06:00Z", "newer")), ["new.mp4"]);
  await s.call("DELETE", "/me", { headers: auth(user) });
  assert.equal(putVideo(s.db, user.id, v("2026-11-04T06:07:00Z", "late")), null);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM videos WHERE seeker_id = ?", user.id), 0);
});

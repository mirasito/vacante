// Обновления Telegram, которые бот на Cloudflare передаёт серверу: всё, что касается профиля.
// Бот сам ничего о людях не хранит, он только пересылает обновление на /internal/telegram
// с общим ключом (internalKey: считается из токена бота, отдельный секрет не нужен).
// Сейчас это номер из окна «Поделиться номером», кружок для профиля, /start video и кнопки «v:…».
import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Ctx } from "./app.ts";
import { HttpError, route, type Request, type Route } from "./http.ts";
import { normalizePhone } from "./profile.ts";
import {
  dropVideo,
  getSeeker,
  getVideo,
  iso,
  phoneAsked,
  putVideo,
  randomCode,
  removeFiles,
  setPhone,
} from "./seekers.ts";
import { internalKey } from "./telegram.ts";
import { MAX_DURATION, MAX_POSTER_BYTES, MAX_VIDEO_BYTES, writeAtomic } from "./video.ts";

export interface TgMessage {
  message_id: number;
  /** Когда сообщение отправлено, секунды Unix. */
  date?: number;
  from?: { id: number; first_name: string; language_code?: string };
  chat: { id: number; type: string };
  text?: string;
  contact?: { phone_number: string; user_id?: number; first_name?: string };
  video_note?: {
    file_id: string;
    file_unique_id: string;
    duration: number;
    length?: number;
    file_size?: number;
    thumbnail?: { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number };
  };
  /** Обычное видео вместо кружка: подсказываем, как записать кружок. */
  video?: { file_id: string; duration: number };
}

export interface TgCallback {
  id: string;
  from: { id: number; first_name: string; language_code?: string };
  data?: string;
  message?: TgMessage;
}

export interface TgUpdate {
  update_id?: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}

const TEXT = {
  ru: {
    phoneSaved: "✅ Номер добавлен в профиль. Работодатель увидит его, когда откроет ваш профиль.",
    noProfile: "Сначала создайте профиль в приложении, это 2 минуты.",
    foreign: "Отправьте свой номер: чужие контакты в профиль не добавляю.",
    notKz: "Пока принимаю только номера Казахстана, +7 7…",
    videoPrompt:
      "🎥 Запишите кружок для профиля, до минуты.\n\n" +
      "Нажмите на значок микрофона внизу справа, он сменится камерой, и удерживайте его, пока говорите.\n\n" +
      "О чём рассказать:\n1. Как вас зовут и кем хотите работать\n2. Где уже работали или чему готовы научиться\n" +
      "3. Когда можете выйти и какой график удобен\n\n" +
      "Кружок увидит только работодатель, которому вы отправите ссылку на профиль.",
    videoNoProfile: "Кружок добавляется в профиль. Сначала создайте профиль в приложении, это 2 минуты.",
    videoNeedNote:
      "Нужен именно кружок: нажмите на значок микрофона внизу справа, он сменится камерой, и удерживайте его, пока говорите.",
    videoTooLong: "Кружок должен быть не длиннее минуты. Запишите покороче, пожалуйста.",
    videoSaved: "✅ Кружок в профиле. Хотите другой — запишите новый, он заменит этот.",
    videoFailed: "Не получилось сохранить кружок. Отправьте его ещё раз, пожалуйста.",
    videoRemove: "🗑 Убрать из профиля",
    videoRemoved: "Кружок убран из профиля.",
    videoReplaced: "Этот кружок уже заменён новым.",
    openApp: "👤 Открыть профиль",
  },
  kk: {
    phoneSaved: "✅ Нөмір профильге қосылды. Жұмыс беруші оны профиліңізді ашқанда көреді.",
    noProfile: "Алдымен қосымшада профиль жасаңыз, бұл 2 минут.",
    foreign: "Өз нөміріңізді жіберіңіз: басқа адамның контактісін профильге қоспаймын.",
    notKz: "Әзірге тек Қазақстан нөмірлерін қабылдаймын, +7 7…",
    videoPrompt:
      "🎥 Профильге бейнехабар жазыңыз, бір минутқа дейін.\n\n" +
      "Төменгі оң жақтағы микрофон белгісін басыңыз, ол камераға ауысады, сөйлеп тұрғанда оны басып тұрыңыз.\n\n" +
      "Не туралы айту керек:\n1. Атыңыз кім және кім болып жұмыс істегіңіз келеді\n" +
      "2. Бұрын қайда жұмыс істедіңіз немесе неге үйренуге дайынсыз\n" +
      "3. Жұмысқа қашан шыға аласыз және қандай кесте ыңғайлы\n\n" +
      "Бейнехабарды тек сіз профиль сілтемесін жіберген жұмыс беруші көреді.",
    videoNoProfile: "Бейнехабар профильге қосылады. Алдымен қосымшада профиль жасаңыз, бұл 2 минут.",
    videoNeedNote:
      "Дөңгелек бейнехабар керек: төменгі оң жақтағы микрофон белгісін басыңыз, ол камераға ауысады, сөйлеп тұрғанда оны басып тұрыңыз.",
    videoTooLong: "Бейнехабар бір минуттан аспауы керек. Қысқарақ жазыңызшы.",
    videoSaved: "✅ Бейнехабар профильде. Басқасын қаласаңыз, жаңасын жазыңыз, ол осының орнына қойылады.",
    videoFailed: "Бейнехабарды сақтау мүмкін болмады. Оны қайта жіберіңізші.",
    videoRemove: "🗑 Профильден алып тастау",
    videoRemoved: "Бейнехабар профильден алынды.",
    videoReplaced: "Бұл бейнехабардың орнына жаңасы қойылған.",
    openApp: "👤 Профильді ашу",
  },
};
type Texts = (typeof TEXT)["ru"];

/** /start video: кнопка «Записать кружок» в приложении открывает чат бота с этой командой. */
const VIDEO_START = /^\/start(@\w+)?\s+video$/;

export function internalRoutes(ctx: Ctx): Route[] {
  const key = Buffer.from(internalKey(ctx.config.botToken));
  const check = (req: Request) => {
    const given = Buffer.from((req.header("authorization") ?? "").replace(/^Bearer /, ""));
    if (given.length !== key.length || !timingSafeEqual(given, key)) throw new HttpError(403, "Нет доступа");
  };

  const textsFor = (from: { id: number; language_code?: string }): Texts =>
    TEXT[getSeeker(ctx.db, from.id)?.lang ?? (from.language_code === "kk" ? "kk" : "ru")];

  // Ответ не дошёл до Telegram: данные всё равно сохранены, а бот не должен разбирать сообщение заново
  const call = async (method: string, body: Record<string, unknown>) => {
    try {
      await ctx.bot.call(method, body);
    } catch (err) {
      console.warn(`${method}: ${err instanceof Error ? err.message : err}`);
    }
  };
  const reply = (chatId: number, text: string, keyboard?: unknown[][]) =>
    call("sendMessage", { chat_id: chatId, text, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) });
  /** Город профиля или null, если профиля ещё нет. */
  const profileCity = (id: number) =>
    (ctx.db.prepare("SELECT city FROM profiles WHERE seeker_id = ?").get(id) as { city: string } | undefined)?.city ?? null;
  const hasProfile = (id: number) => profileCity(id) !== null;
  // «Открыть профиль»: сразу вкладка профиля; город нужен приложению, если на этом устройстве его ещё не выбрали
  const appButton = (t: Texts, city?: string | null) => {
    const query = new URLSearchParams({ tab: "profile", ...(city ? { city } : {}) });
    return { text: t.openApp, web_app: { url: `${ctx.config.siteUrl}/app/?${query}` } };
  };

  async function onContact(m: TgMessage) {
    const from = m.from;
    if (!from || !m.contact) return false;
    // Номер идёт в профиль, только если приложение только что попросило его кнопкой Telegram.
    // Иначе контакт отвечает на вопрос бота (отклик на вакансию), и его обрабатывает сам бот.
    if (!phoneAsked(ctx.db, from.id, ctx.now())) return false;
    const t = textsFor(from);
    // Telegram подтверждает, что номер свой, только когда user_id контакта совпадает с отправителем
    if (m.contact.user_id !== from.id) {
      await reply(m.chat.id, t.foreign);
      return true;
    }
    const phone = normalizePhone(m.contact.phone_number);
    if (!phone) {
      await reply(m.chat.id, t.notKz);
      return true;
    }
    await reply(m.chat.id, setPhone(ctx.db, from.id, phone, ctx.now()) ? t.phoneSaved : t.noProfile);
    return true;
  }

  async function onVideoNote(m: TgMessage & { from: NonNullable<TgMessage["from"]> }) {
    const t = textsFor(m.from);
    if (!hasProfile(m.from.id)) return reply(m.chat.id, t.videoNoProfile, [[appButton(t)]]);
    const note = m.video_note!;
    if (note.duration > MAX_DURATION || (note.file_size ?? 0) > MAX_VIDEO_BYTES) return reply(m.chat.id, t.videoTooLong);
    // Telegram отдаёт файл несколько секунд, а бот ждёт ответа сервера недолго: качаем после ответа
    ctx.background(saveVideoNote(m, t));
  }

  async function saveVideoNote(m: TgMessage & { from: NonNullable<TgMessage["from"]> }, t: Texts) {
    const note = m.video_note!;
    const dir = ctx.config.videosDir;
    const name = `${m.from.id}-${randomCode()}`;
    const files = [`${name}.mp4`, `${name}.jpg`];
    try {
      const video = await ctx.bot.download(note.file_id, MAX_VIDEO_BYTES);
      // Без обложки кружок всё равно сохраняем: страница покажет просто тёмный круг
      const poster = note.thumbnail
        ? await ctx.bot.download(note.thumbnail.file_id, MAX_POSTER_BYTES).catch(() => null)
        : null;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeAtomic(join(dir, files[0]!), video);
      if (poster) writeAtomic(join(dir, files[1]!), poster);
      const old = putVideo(ctx.db, m.from.id, {
        file_id: note.file_id,
        file_unique_id: note.file_unique_id,
        file: files[0]!,
        poster: poster ? files[1]! : null,
        duration: note.duration,
        size: video.length,
        recorded_at: iso(m.date ? m.date * 1000 : ctx.now()),
      });
      if (old === null) {
        // Профиль удалили, пока кружок качался, или уже пришёл кружок новее
        removeFiles(dir, files);
        return;
      }
      removeFiles(dir, old);
      await reply(m.chat.id, t.videoSaved, [
        [{ text: t.videoRemove, callback_data: `v:del:${note.file_unique_id}`.slice(0, 64) }],
        [appButton(t, profileCity(m.from.id))],
      ]);
    } catch (err) {
      removeFiles(dir, files);
      console.warn(`кружок ${m.from.id}: ${err instanceof Error ? err.message : err}`);
      await reply(m.chat.id, t.videoFailed);
    }
  }

  async function onCallback(q: TgCallback) {
    const data = q.data ?? "";
    if (!data.startsWith("v:")) return false;
    const t = textsFor(q.from);
    const [, action, unique] = data.split(":");
    if (action === "del") {
      const video = getVideo(ctx.db, q.from.id);
      // Кнопка под старым сообщением не должна стирать кружок, записанный после него
      if (video && unique && !video.file_unique_id.startsWith(unique)) {
        await call("answerCallbackQuery", { callback_query_id: q.id, text: t.videoReplaced });
        return true;
      }
      dropVideo(ctx.db, q.from.id, ctx.config.videosDir);
      await call("answerCallbackQuery", { callback_query_id: q.id, text: t.videoRemoved });
      if (q.message) {
        await call("editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text: `🗑 ${t.videoRemoved}` });
      }
      return true;
    }
    await call("answerCallbackQuery", { callback_query_id: q.id });
    return true;
  }

  return [
    route("POST", "api", "/internal/telegram", async (req) => {
      check(req);
      const update = (await req.json<TgUpdate>()) ?? {};
      const m = update.message;
      let handled = false;
      if (m && m.chat.type === "private" && m.from) {
        const msg = m as TgMessage & { from: NonNullable<TgMessage["from"]> };
        if (m.contact) handled = await onContact(m);
        else if (m.video_note) {
          await onVideoNote(msg);
          handled = true;
        } else if (VIDEO_START.test(m.text?.trim() ?? "")) {
          const t = textsFor(m.from);
          if (!hasProfile(m.from.id)) await reply(m.chat.id, t.videoNoProfile, [[appButton(t)]]);
          else await reply(m.chat.id, t.videoPrompt);
          handled = true;
        } else if (m.video && hasProfile(m.from.id)) {
          // Обычное видео от человека с профилем — почти наверняка попытка добавить кружок.
          // Без профиля видео остаётся боту: оно может быть ответом в его диалоге
          await reply(m.chat.id, textsFor(m.from).videoNeedNote);
          handled = true;
        }
      } else if (update.callback_query) {
        handled = await onCallback(update.callback_query);
      }
      return { json: { ok: true, handled } };
    }),
  ];
}

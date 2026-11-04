// Обновления Telegram, которые бот на Cloudflare передаёт серверу: всё, что касается профиля.
// Бот сам ничего о людях не хранит, он только пересылает обновление на /internal/telegram
// с общим ключом (internalKey: считается из токена бота, отдельный секрет не нужен).
import { timingSafeEqual } from "node:crypto";

import type { Ctx } from "./app.ts";
import { HttpError, route, type Request, type Route } from "./http.ts";
import { normalizePhone } from "./profile.ts";
import { getSeeker, phoneAsked, setPhone } from "./seekers.ts";
import { internalKey } from "./telegram.ts";

export interface TgMessage {
  message_id: number;
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
}

export interface TgUpdate {
  update_id?: number;
  message?: TgMessage;
  callback_query?: { id: string; from: { id: number; first_name: string }; data?: string; message?: TgMessage };
}

const TEXT = {
  ru: {
    phoneSaved: "✅ Номер добавлен в профиль. Работодатель увидит его, когда откроет ваш профиль.",
    noProfile: "Сначала создайте профиль в приложении, это 2 минуты.",
    foreign: "Отправьте свой номер: чужие контакты в профиль не добавляю.",
    notKz: "Пока принимаю только номера Казахстана, +7 7…",
  },
  kk: {
    phoneSaved: "✅ Нөмір профильге қосылды. Жұмыс беруші оны профиліңізді ашқанда көреді.",
    noProfile: "Алдымен қосымшада профиль жасаңыз, бұл 2 минут.",
    foreign: "Өз нөміріңізді жіберіңіз: басқа адамның контактісін профильге қоспаймын.",
    notKz: "Әзірге тек Қазақстан нөмірлерін қабылдаймын, +7 7…",
  },
};

export function internalRoutes(ctx: Ctx): Route[] {
  const key = Buffer.from(internalKey(ctx.config.botToken));
  const check = (req: Request) => {
    const given = Buffer.from((req.header("authorization") ?? "").replace(/^Bearer /, ""));
    if (given.length !== key.length || !timingSafeEqual(given, key)) throw new HttpError(403, "Нет доступа");
  };

  // Ответ не дошёл до Telegram: номер всё равно сохранён, а бот не должен разбирать контакт заново
  const reply = async (chatId: number, text: string) => {
    try {
      await ctx.bot.call("sendMessage", { chat_id: chatId, text });
    } catch (err) {
      console.warn(`sendMessage: ${err instanceof Error ? err.message : err}`);
    }
  };

  async function onContact(m: TgMessage) {
    const from = m.from;
    if (!from || !m.contact) return false;
    // Номер идёт в профиль, только если приложение только что попросило его кнопкой Telegram.
    // Иначе контакт отвечает на вопрос бота (отклик на вакансию), и его обрабатывает сам бот.
    if (!phoneAsked(ctx.db, from.id, ctx.now())) return false;
    const t = TEXT[getSeeker(ctx.db, from.id)?.lang ?? "ru"];
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

  return [
    route("POST", "api", "/internal/telegram", async (req) => {
      check(req);
      const update = (await req.json<TgUpdate>()) ?? {};
      const m = update.message;
      let handled = false;
      if (m && m.chat.type === "private") {
        if (m.contact) handled = await onContact(m);
      }
      return { json: { ok: true, handled } };
    }),
  ];
}

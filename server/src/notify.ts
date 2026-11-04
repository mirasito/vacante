// Сообщения соискателю в чате бота о его откликах: работодатель открыл профиль по ссылке отклика
// или ответил кнопкой на странице профиля. С 21:00 до 9:00 они приходят без звука.
import type { Ctx } from "./app.ts";
import type { ApplicationRow } from "./applications.ts";
import type { Lang } from "./labels.ts";
import { getSeeker } from "./seekers.ts";
import { dateTimeLabel, quietHours } from "./time.ts";

const T = {
  ru: {
    seen: (title: string, who: string) =>
      `👀 Ваш профиль открыли по отклику «${title}»${who}. Самое время позвонить или написать, пока вас помнят.`,
    invite: (title: string, who: string) => `🎉 Вас приглашают на собеседование по отклику «${title}»${who}.`,
    when: (date: string) => `Когда: ${date}.`,
    where: (address: string) => `Адрес: ${address}.`,
    agree: "Договоритесь о времени и укажите его в «Откликах».",
    reject: (title: string, who: string) =>
      `Ответ по отклику «${title}»${who}: пока не подходит. Так бывает, в ленте есть и другие вакансии.`,
    open: "📋 Мои отклики",
  },
  kk: {
    seen: (title: string, who: string) =>
      `👀 «${title}» өтінімі бойынша профиліңізді ашты${who}. Сізді есінде сақтап тұрғанда қоңырау шалыңыз немесе жазыңыз.`,
    invite: (title: string, who: string) => `🎉 «${title}» өтінімі бойынша сұхбатқа шақырады${who}.`,
    when: (date: string) => `Қашан: ${date}.`,
    where: (address: string) => `Мекенжайы: ${address}.`,
    agree: "Уақытын келісіп, оны «Өтінімдер» бөлімінде көрсетіңіз.",
    reject: (title: string, who: string) =>
      `«${title}» өтінімі бойынша жауап${who}: әзірге сәйкес келмейді. Бұлай болады, лентада басқа бос орындар да бар.`,
    open: "📋 Менің өтінімдерім",
  },
};

export type ApplicationNews = "seen" | "invite" | "reject";

export function newsText(kind: ApplicationNews, app: ApplicationRow, lang: Lang): string {
  const t = T[lang];
  const title = lang === "kk" && app.title_kk ? app.title_kk : app.title;
  const who = app.employer ? ` (${app.employer})` : "";
  if (kind === "seen") return t.seen(title, who);
  if (kind === "reject") return t.reject(title, who);
  const lines = [t.invite(title, who)];
  if (app.interview_at) {
    lines.push(t.when(dateTimeLabel(Date.parse(app.interview_at), lang)));
    if (app.address) lines.push(t.where(app.address));
  } else {
    lines.push(t.agree);
  }
  return lines.join("\n");
}

/** Пишет соискателю в чат бота. Не дошло (человек не запускал бота или заблокировал его) — не беда. */
export async function sendNews(ctx: Ctx, kind: ApplicationNews, app: ApplicationRow): Promise<void> {
  const seeker = getSeeker(ctx.db, app.seeker_id);
  if (!seeker) return;
  const lang = seeker.lang;
  const query = new URLSearchParams({ tab: "applications", ...(app.city ? { city: app.city } : {}) });
  try {
    await ctx.bot.call("sendMessage", {
      chat_id: seeker.id,
      text: newsText(kind, app, lang),
      disable_notification: quietHours(ctx.now()),
      reply_markup: { inline_keyboard: [[{ text: T[lang].open, web_app: { url: `${ctx.config.siteUrl}/app/?${query}` } }]] },
    });
  } catch (err) {
    console.warn(`отклик ${app.id}: сообщение не ушло: ${err instanceof Error ? err.message : err}`);
  }
}

// Напоминания в чате бота: тексты и кнопки, отправка тех, кому пора, нажатия кнопок под ними
// и команды /napominaniya и /otkliki. Кнопки работают без открытия приложения: бот на Cloudflare
// передаёт нажатия серверу (internal.ts), и сервер сам меняет стадию отклика или напоминание.
// В бот уходит не больше двух напоминаний в день и только с 9:00 до 21:00 по Казахстану.
// Исключение одно: напоминание за два часа до собеседования приходит вовремя, но не раньше 7:00.
import type { Ctx } from "./app.ts";
import { ensureLink, getApplication, patchApplication, weekNumbers, type ApplicationRow, type Stage } from "./applications.ts";
import { fetchPostContacts, POST_URL, type PostContacts } from "./contacts.ts";
import type { TgCallback } from "./internal.ts";
import type { Lang } from "./labels.ts";
import {
  actOn,
  expire,
  getReminder,
  groupOf,
  isActive,
  listReminders,
  PER_DAY,
  planAll,
  planReminders,
  snoozeTime,
  turnOff,
  WINDOW,
  type Kind,
  type ReminderRow,
  type ReminderView,
} from "./reminders.ts";
import { RateLimit } from "./limits.ts";
import { getProfile, getSeeker, iso } from "./seekers.ts";
import { TelegramError } from "./telegram.ts";
import { dateLabel, dateTimeLabel, dayWord, DAY_MS, localDayStart, localHour, timeLabel, weekStart } from "./time.ts";

export type BotDeps = Pick<Ctx, "db" | "bot" | "config" | "fetch" | "now">;

type Button = { text: string; callback_data?: string; url?: string; web_app?: { url: string } };
export interface Message {
  text: string;
  keyboard: Button[][];
}

function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return one;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
  return many;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const T = {
  ru: {
    writeAgain: (title: string, who: string) =>
      `✉️ По отклику «${title}»${who} пока тихо: профиль не открывали. Можно вежливо напомнить о себе, это нормально.`,
    followUp: (title: string, link: string | null) =>
      `Здравствуйте! Напоминаю о своём отклике на вакансию «${title}». Вакансия ещё актуальна?${link ? `\nМой профиль: ${link}` : ""}`,
    textBelow: "Текст для сообщения:",
    whatsapp: "💬 Написать в WhatsApp",
    telegram: "✈️ Открыть чат в Telegram",
    post: "↗ Открыть пост",
    no: "Не надо",
    statusCheck: (title: string, who: string) =>
      `❓ Что с откликом на «${title}»${who}? Прошла неделя. Отметьте ответ, и Vacante подскажет следующий шаг.`,
    invited: "🎉 Пригласили",
    rejected: "Отказали",
    silence: "Тишина",
    interviewEve: (day: string, time: string, title: string, who: string) => `📅 ${cap(day)} в ${time} собеседование: «${title}»${who}.`,
    interviewSoon: (time: string, title: string, who: string) => `⏰ Сегодня в ${time} собеседование: «${title}»${who}.`,
    address: (a: string) => `Адрес: ${a}.`,
    map: "🗺 Адрес на карте",
    late: "⏰ Опаздываю",
    move: "🔁 Перенести",
    howWasIt: (title: string, who: string) => `🤝 Как прошло собеседование на «${title}»${who}?`,
    offer: "🎉 Предложили работу",
    wait: "Жду ответа",
    startEve: (title: string, who: string) => `💼 Завтра первый рабочий день: «${title}»${who}.`,
    bring: (medBook: boolean) => `Возьмите удостоверение личности${medBook ? " и санкнижку" : ""}. Удачи!`,
    profile:
      "🎥 Профиль с кружком открывают охотнее. Расскажите о себе за минуту: как вас зовут, кем хотите работать и когда можете выйти.",
    record: "🎥 Записать кружок",
    week: (sent: number, seen: number, invited: number) =>
      `📊 Итог прошлой недели: ${sent} ${plural(sent, "отклик", "отклика", "откликов")}` +
      `, ${seen} посмотрели, ${invited} ${plural(invited, "приглашение", "приглашения", "приглашений")}.\nНовые вакансии уже в ленте.`,
    myApps: "📋 Мои отклики",
    feed: "🃏 Листать вакансии",
    custom: (text: string) => `🔔 ${text}`,
    done: "✅ Готово",
    snooze: "⏰ Через час",
    off: "🔕 Не присылать такие",
    pressedNo: "Хорошо, не будем.",
    pressedOff: "🔕 Такие напоминания больше не придут. Включить их снова можно в профиле.",
    pressedStage: (label: string) => `✓ Отмечено: ${label}.`,
    pressedWait: "✓ Хорошо, ждём ответа.",
    pressedDone: "✅ Готово.",
    pressedSnooze: (when: string) => `⏰ Напомню ${when}.`,
    stale: "Это напоминание уже неактуально.",
    lateText: (name: string, time: string, title: string) =>
      `Здравствуйте! Это ${name}, у меня в ${time} собеседование по вакансии «${title}». Немного опаздываю, буду минут через 15. Извините, пожалуйста!`,
    lateIntro: "Текст для работодателя, его можно скопировать:",
    lateSend: "💬 Отправить в WhatsApp",
    lateAgain: "Текст уже есть в чате выше.",
    noProfile: "Отклики и напоминания хранятся в профиле. Создайте его в приложении, это 2 минуты.",
    createProfile: "👤 Создать профиль",
    appsTitle: "📋 Ваши отклики",
    appsEmpty: "Откликов пока нет. Листайте вакансии и смахивайте вправо те, что нравятся.",
    groups: { interviews: "Собеседования", work: "Работа", waiting: "Ждут ответа" },
    likedCount: (n: number) => `Нравится: ${n}`,
    more: (n: number) => `и ещё ${n}`,
    interviewAt: (when: string) => `собеседование ${when}`,
    startAt: (day: string) => `выход ${day}`,
    openApps: "📋 Открыть отклики",
    remindersTitle: "🔔 Напоминания",
    remindersEmpty: "Напоминаний пока нет. Они появятся, когда вы откликнетесь на вакансии.",
    today: "Сегодня",
    tomorrow: "Завтра",
    later: "Позже",
    openReminders: "🔔 Открыть напоминания",
    kinds: {
      write_again: "Написать ещё раз",
      status_check: "Что с откликом?",
      interview_eve: "Собеседование",
      interview_soon: "Собеседование",
      how_was_it: "Как прошло собеседование?",
      start_eve: "Выход на работу",
      profile: "Записать кружок для профиля",
      week: "Итог недели",
      custom: "Своё",
    } as Record<Kind, string>,
    stages: {
      liked: "нравится",
      sent: "отправлен",
      seen: "просмотрен",
      invited: "пригласили",
      interview: "собеседование",
      offer: "предложили работу",
      hired: "работаю здесь",
      rejected: "отказ",
      no_answer: "нет ответа",
      not_interested: "уже не интересно",
    } as Record<Stage, string>,
  },
  kk: {
    writeAgain: (title: string, who: string) =>
      `✉️ «${title}»${who} өтінімі бойынша әзірге үнсіз: профильді ашпады. Өзіңізді сыпайы еске салуға болады, бұл қалыпты жағдай.`,
    followUp: (title: string, link: string | null) =>
      `Сәлеметсіз бе! «${title}» бос орнына жіберген өтінімімді еске саламын. Бос орын әлі өзекті ме?${link ? `\nМенің профилім: ${link}` : ""}`,
    textBelow: "Хабарлама мәтіні:",
    whatsapp: "💬 WhatsApp-қа жазу",
    telegram: "✈️ Telegram-да чатты ашу",
    post: "↗ Постты ашу",
    no: "Керек емес",
    statusCheck: (title: string, who: string) =>
      `❓ «${title}»${who} өтінімі қалай? Бір апта өтті. Жауапты белгілеңіз, Vacante келесі қадамды айтады.`,
    invited: "🎉 Шақырды",
    rejected: "Бас тартты",
    silence: "Жауап жоқ",
    interviewEve: (day: string, time: string, title: string, who: string) => `📅 ${cap(day)} сағат ${time}-да сұхбат: «${title}»${who}.`,
    interviewSoon: (time: string, title: string, who: string) => `⏰ Бүгін сағат ${time}-да сұхбат: «${title}»${who}.`,
    address: (a: string) => `Мекенжайы: ${a}.`,
    map: "🗺 Картада ашу",
    late: "⏰ Кешігіп жатырмын",
    move: "🔁 Ауыстыру",
    howWasIt: (title: string, who: string) => `🤝 «${title}»${who} сұхбаты қалай өтті?`,
    offer: "🎉 Жұмыс ұсынды",
    wait: "Жауап күтемін",
    startEve: (title: string, who: string) => `💼 Ертең жұмыстың алғашқы күні: «${title}»${who}.`,
    bring: (medBook: boolean) => `Жеке куәлігіңізді${medBook ? " және санитарлық кітапшаңызды" : ""} ала барыңыз. Сәттілік!`,
    profile:
      "🎥 Бейнехабары бар профильді жиірек ашады. Бір минутта өзіңіз туралы айтыңыз: атыңыз кім, кім болып жұмыс істегіңіз келеді және қашан шыға аласыз.",
    record: "🎥 Бейнехабар жазу",
    week: (sent: number, seen: number, invited: number) =>
      `📊 Өткен аптаның қорытындысы: ${sent} өтінім, ${seen} қаралды, ${invited} шақыру.\nЖаңа бос орындар лентада.`,
    myApps: "📋 Менің өтінімдерім",
    feed: "🃏 Бос орындарды қарау",
    custom: (text: string) => `🔔 ${text}`,
    done: "✅ Дайын",
    snooze: "⏰ Бір сағаттан кейін",
    off: "🔕 Мұндайларды жібермеу",
    pressedNo: "Жарайды, керек емес.",
    pressedOff: "🔕 Мұндай еске салғыштар енді келмейді. Оларды профильде қайта қосуға болады.",
    pressedStage: (label: string) => `✓ Белгіленді: ${label}.`,
    pressedWait: "✓ Жарайды, жауап күтеміз.",
    pressedDone: "✅ Дайын.",
    pressedSnooze: (when: string) => `⏰ ${when} еске саламын.`,
    stale: "Бұл еске салғыш енді өзекті емес.",
    lateText: (name: string, time: string, title: string) =>
      `Сәлеметсіз бе! Бұл ${name}, «${title}» бос орны бойынша сағат ${time}-да сұхбатым бар. Сәл кешігіп жатырмын, 15 минуттай кейін келемін. Кешіріңізші!`,
    lateIntro: "Жұмыс берушіге арналған мәтін, оны көшіріп алуға болады:",
    lateSend: "💬 WhatsApp-қа жіберу",
    lateAgain: "Мәтін чатта жоғарыда тұр.",
    noProfile: "Өтінімдер мен еске салғыштар профильде сақталады. Оны қосымшада жасаңыз, бұл 2 минут.",
    createProfile: "👤 Профиль жасау",
    appsTitle: "📋 Сіздің өтінімдеріңіз",
    appsEmpty: "Әзірге өтінім жоқ. Бос орындарды қарап, ұнағанын оңға сырғытыңыз.",
    groups: { interviews: "Сұхбаттар", work: "Жұмыс", waiting: "Жауап күтуде" },
    likedCount: (n: number) => `Ұнайды: ${n}`,
    more: (n: number) => `тағы ${n}`,
    interviewAt: (when: string) => `сұхбат ${when}`,
    startAt: (day: string) => `жұмысқа шығу ${day}`,
    openApps: "📋 Өтінімдерді ашу",
    remindersTitle: "🔔 Еске салғыштар",
    remindersEmpty: "Әзірге еске салғыш жоқ. Олар бос орындарға өтінім жібергенде пайда болады.",
    today: "Бүгін",
    tomorrow: "Ертең",
    later: "Кейінірек",
    openReminders: "🔔 Еске салғыштарды ашу",
    kinds: {
      write_again: "Тағы жазу",
      status_check: "Өтінім қалай?",
      interview_eve: "Сұхбат",
      interview_soon: "Сұхбат",
      how_was_it: "Сұхбат қалай өтті?",
      start_eve: "Жұмысқа шығу",
      profile: "Профильге бейнехабар жазу",
      week: "Апта қорытындысы",
      custom: "Өзімдікі",
    } as Record<Kind, string>,
    stages: {
      liked: "ұнайды",
      sent: "жіберілді",
      seen: "қаралды",
      invited: "шақырды",
      interview: "сұхбат",
      offer: "жұмыс ұсынды",
      hired: "осында жұмыс істеймін",
      rejected: "бас тартты",
      no_answer: "жауап жоқ",
      not_interested: "енді қызық емес",
    } as Record<Stage, string>,
  },
};
type Texts = (typeof T)["ru"];

const titleOf = (a: Pick<ApplicationRow, "title" | "title_kk">, lang: Lang) => (lang === "kk" && a.title_kk) || a.title;
const whoOf = (a: Pick<ApplicationRow, "employer">) => (a.employer ? ` (${a.employer})` : "");
const waUrl = (phone: string, text: string) => `https://wa.me/${phone.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
const cb = (r: { id: number }, action: string) => `r:${r.id}:${action}`;

function appUrl(deps: BotDeps, params: Record<string, string | null | undefined>): string {
  const query = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1]));
  return `${deps.config.siteUrl}/app/?${query}`;
}

/** Контакт из поста отклика, только сейчас и только для этого сообщения. Не нашёлся — null. */
async function contactOf(deps: BotDeps, a: ApplicationRow): Promise<PostContacts | null> {
  if (!a.source_url || !POST_URL.test(a.source_url)) return null;
  try {
    return await fetchPostContacts(deps.fetch, a.source_url);
  } catch (err) {
    console.warn(`пост ${a.source_url}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Кнопка «написать работодателю»: WhatsApp с текстом, чат в Telegram или пост, если контакта нет. */
async function writeButton(deps: BotDeps, a: ApplicationRow, text: string, t: Texts, waLabel: string): Promise<Button | null> {
  const found = a.method === "whatsapp" || a.method === "telegram" || a.method === "call" ? await contactOf(deps, a) : null;
  if (found?.whatsapp && a.method !== "telegram") return { text: waLabel, url: waUrl(found.whatsapp, text) };
  if (found?.telegram && a.method === "telegram") return { text: t.telegram, url: `https://t.me/${found.telegram}` };
  if (found?.whatsapp) return { text: waLabel, url: waUrl(found.whatsapp, text) };
  if (found?.telegram) return { text: t.telegram, url: `https://t.me/${found.telegram}` };
  return a.source_url ? { text: t.post, url: a.source_url } : null;
}

/** Сообщение для напоминания. null — отправлять уже нечего. */
export async function render(deps: BotDeps, r: ReminderRow, now: number): Promise<Message | null> {
  const seeker = getSeeker(deps.db, r.seeker_id);
  if (!seeker) return null;
  const lang = seeker.lang;
  const t = T[lang];
  const a = r.application_id ? getApplication(deps.db, r.seeker_id, r.application_id) : undefined;
  if (r.application_id && !a) return null;
  const off = groupOf(r.kind) ? [[{ text: t.off, callback_data: cb(r, "off") }]] : [];
  const mapRow = a?.map ? [{ text: t.map, url: a.map }] : [];
  switch (r.kind) {
    case "write_again": {
      const title = titleOf(a!, lang);
      const code = ensureLink(deps.db, r.seeker_id, a!.id, now);
      const text = t.followUp(title, `${deps.config.profileOrigin}/${code}`);
      const button = await writeButton(deps, a!, text, t, t.whatsapp);
      const copy = button?.url?.startsWith("https://wa.me/") ? "" : `\n\n${t.textBelow}\n${text}`;
      return {
        text: t.writeAgain(title, whoOf(a!)) + copy,
        keyboard: [...(button ? [[button]] : []), [{ text: t.no, callback_data: cb(r, "no") }], ...off],
      };
    }
    case "status_check":
      return {
        text: t.statusCheck(titleOf(a!, lang), whoOf(a!)),
        keyboard: [
          [{ text: t.invited, callback_data: cb(r, "invited") }],
          [
            { text: t.rejected, callback_data: cb(r, "rejected") },
            { text: t.silence, callback_data: cb(r, "no_answer") },
          ],
          ...off,
        ],
      };
    case "interview_eve":
    case "interview_soon": {
      if (!a!.interview_at) return null;
      const at = Date.parse(a!.interview_at);
      const head =
        r.kind === "interview_soon"
          ? t.interviewSoon(timeLabel(at), titleOf(a!, lang), whoOf(a!))
          : t.interviewEve(dayWord(at, now, lang), timeLabel(at), titleOf(a!, lang), whoOf(a!));
      return {
        text: [head, a!.address ? t.address(a!.address) : ""].filter(Boolean).join("\n"),
        keyboard: [
          ...(mapRow.length ? [mapRow] : []),
          [
            { text: t.late, callback_data: cb(r, "late") },
            { text: t.move, web_app: { url: appUrl(deps, { tab: "applications", app: String(a!.id), city: a!.city }) } },
          ],
          ...off,
        ],
      };
    }
    case "how_was_it":
      return {
        text: t.howWasIt(titleOf(a!, lang), whoOf(a!)),
        keyboard: [
          [{ text: t.offer, callback_data: cb(r, "offer") }],
          [
            { text: t.rejected, callback_data: cb(r, "rejected") },
            { text: t.wait, callback_data: cb(r, "wait") },
          ],
          ...off,
        ],
      };
    case "start_eve": {
      const profile = getProfile(deps.db, r.seeker_id);
      return {
        text: [t.startEve(titleOf(a!, lang), whoOf(a!)), a!.address ? t.address(a!.address) : "", t.bring(!!profile?.med_book)]
          .filter(Boolean)
          .join("\n"),
        keyboard: [...(mapRow.length ? [mapRow] : []), ...off],
      };
    }
    case "profile":
      return { text: t.profile, keyboard: [[{ text: t.record, callback_data: cb(r, "video") }], ...off] };
    case "week": {
      const monday = weekStart(Date.parse(r.due_at));
      const n = weekNumbers(deps.db, r.seeker_id, iso(monday - 7 * DAY_MS), iso(monday));
      const city = getProfile(deps.db, r.seeker_id)?.city;
      return {
        text: t.week(n.sent, n.seen, n.invited),
        keyboard: [
          [
            { text: t.myApps, web_app: { url: appUrl(deps, { tab: "applications", city }) } },
            { text: t.feed, web_app: { url: appUrl(deps, { city }) } },
          ],
          ...off,
        ],
      };
    }
    case "custom":
      return {
        text: t.custom(r.text ?? ""),
        keyboard: [
          [
            { text: t.done, callback_data: cb(r, "done") },
            { text: t.snooze, callback_data: cb(r, "snooze") },
          ],
        ],
      };
  }
}

const PRIORITY: Record<Kind, number> = {
  interview_soon: 0,
  interview_eve: 1,
  start_eve: 2,
  how_was_it: 3,
  custom: 4,
  status_check: 5,
  write_again: 6,
  profile: 7,
  week: 8,
};

/** Можно ли отправить напоминание такого типа сейчас: окно 9–21, за два часа до собеседования — с 7:00. */
export function inWindow(kind: Kind, now: number): boolean {
  const h = localHour(now);
  return kind === "interview_soon" ? h >= WINDOW.interviewFrom : h >= WINDOW.from && h < WINDOW.to;
}

/**
 * Подсказки, которые могут подождать: из них в бот уходит одна в день, чтобы второе место
 * осталось собеседованию, первому рабочему дню или своему напоминанию.
 */
const NUDGES: readonly Kind[] = ["status_check", "write_again", "profile", "week"];

/**
 * Отправляет в бот напоминания, которым пора: по одному человеку, важные первыми, не больше двух
 * в день. Что не прошло по времени или лимиту, ждёт следующего запуска. Возвращает, сколько ушло.
 * Вне правил только напоминание за два часа до собеседования и отложенное: о нём человек попросил сам.
 */
export async function sendDue(deps: BotDeps, now: number): Promise<number> {
  const db = deps.db;
  expire(db, now);
  const due = db
    .prepare(
      `SELECT r.* FROM reminders r JOIN seekers s ON s.id = r.seeker_id
       WHERE r.status = 'waiting' AND r.due_at <= ? AND s.reminders_bot = 1
       ORDER BY r.seeker_id, r.due_at`,
    )
    .all(iso(now)) as unknown as ReminderRow[];
  const bySeeker = new Map<number, ReminderRow[]>();
  for (const r of due) bySeeker.set(r.seeker_id, [...(bySeeker.get(r.seeker_id) ?? []), r]);
  const today = iso(localDayStart(now));
  const counted = db.prepare("SELECT kind FROM reminders WHERE seeker_id = ? AND sent_at >= ? AND kind != 'interview_soon'");
  let total = 0;
  for (const [seekerId, list] of bySeeker) {
    const sent = (counted.all(seekerId, today) as { kind: Kind }[]).map((r) => r.kind);
    let sentToday = sent.length;
    let nudgesToday = sent.filter((k) => NUDGES.includes(k)).length;
    list.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || (a.due_at < b.due_at ? -1 : 1));
    for (const r of list) {
      if (!inWindow(r.kind, now)) continue;
      const exempt = r.kind === "interview_soon" || r.sent_at !== null;
      const nudge = NUDGES.includes(r.kind);
      if (!exempt && (sentToday >= PER_DAY || (nudge && nudgesToday >= 1))) continue;
      if ((await deliver(deps, r, now)) !== "sent") continue;
      total++;
      if (exempt) continue;
      sentToday++;
      if (nudge) nudgesToday++;
    }
  }
  return total;
}

/** Отметка об отправке. Если человек успел нажать «Готово» или «Убрать», пока сообщение уходило, стадию не трогаем. */
const markSent = (deps: BotDeps, id: number, at: string, messageId: number | null) =>
  deps.db
    .prepare(
      `UPDATE reminders SET status = CASE WHEN status = 'waiting' THEN 'sent' ELSE status END,
         sent_at = ?, message_id = ?, updated_at = ? WHERE id = ?`,
    )
    .run(at, messageId, at, id);

async function deliver(deps: BotDeps, r: ReminderRow, now: number): Promise<"sent" | "skipped" | "retry"> {
  const db = deps.db;
  const at = iso(now);
  // Пока отправлялись предыдущие, человек мог закрыть это напоминание в приложении
  const current = db.prepare("SELECT status FROM reminders WHERE id = ?").get(r.id) as { status: string } | undefined;
  if (current?.status !== "waiting") return "skipped";
  const message = await render(deps, r, now);
  if (!message) {
    db.prepare("UPDATE reminders SET status = 'dismissed', closed_by = 'system', updated_at = ? WHERE id = ? AND status = 'waiting'").run(
      at,
      r.id,
    );
    return "skipped";
  }
  try {
    const sent = await deps.bot.call<{ message_id: number }>("sendMessage", {
      chat_id: r.seeker_id,
      text: message.text,
      reply_markup: { inline_keyboard: message.keyboard },
      link_preview_options: { is_disabled: true },
    });
    markSent(deps, r.id, at, sent?.message_id ?? null);
    return "sent";
  } catch (err) {
    // Человек заблокировал бота или ни разу его не запускал: повторять бессмысленно, в приложении напоминание есть
    if (err instanceof TelegramError && (err.code === 403 || err.code === 400)) {
      console.warn(`напоминание ${r.id}: ${err.message}`);
      markSent(deps, r.id, at, null);
      return "sent";
    }
    console.warn(`напоминание ${r.id}: повторю позже: ${err instanceof Error ? err.message : err}`);
    return "retry";
  }
}

/** Один проход планировщика: сверить напоминания всех и отправить тех, кому пора. */
export async function runReminders(deps: BotDeps): Promise<number> {
  const now = deps.now();
  planAll(deps.db, now);
  return sendDue(deps, now);
}

/** Планировщик в процессе сервера: раз в 5 минут, проходы не накладываются друг на друга. */
export function startScheduler(deps: BotDeps, everyMs = 5 * 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const sent = await runReminders(deps);
      if (sent) console.log(`напоминания: отправлено ${sent}`);
    } catch (err) {
      console.error(`напоминания: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 10_000);
  const timer = setInterval(tick, everyMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

export interface PressHooks {
  /** «Записать кружок»: та же подсказка, что по /start video. */
  videoPrompt(chatId: number, lang: Lang): Promise<unknown>;
}

const STAGE_OF: Record<string, Stage> = { invited: "invited", rejected: "rejected", no_answer: "no_answer", offer: "offer" };
/** «Опаздываю» открывает пост на t.me: не чаще трёх раз за 10 минут на человека. */
const lateLimit = new RateLimit(3, 10 * 60_000);

/** Нажатие кнопки под напоминанием: r:<id>:<действие>. */
export async function pressReminder(deps: BotDeps, q: TgCallback, hooks: PressHooks): Promise<void> {
  const db = deps.db;
  const now = deps.now();
  const seeker = getSeeker(db, q.from.id);
  const lang: Lang = seeker?.lang ?? (q.from.language_code === "kk" ? "kk" : "ru");
  const t = T[lang];
  const call = async (method: string, body: Record<string, unknown>) => {
    try {
      await deps.bot.call(method, body);
    } catch (err) {
      console.warn(`${method}: ${err instanceof Error ? err.message : err}`);
    }
  };
  const answer = (text?: string) => call("answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text } : {}) });
  // Под сообщением дописываем, что сделано, и убираем кнопки
  const mark = (note: string) =>
    q.message?.text
      ? call("editMessageText", {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          text: `${q.message.text}\n\n${note}`,
          link_preview_options: { is_disabled: true },
        })
      : Promise.resolve();

  const [, rawId = "", action = ""] = (q.data ?? "").split(":");
  const r = seeker ? getReminder(db, seeker.id, Number(rawId)) : undefined;
  if (!r || !isActive(r, now)) {
    await answer(t.stale);
    if (q.message) await call("editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id });
    return;
  }
  const close = (kind: "done" | "dismiss") => actOn(db, r.seeker_id, r.id, { kind }, now);
  const a = r.application_id ? getApplication(db, r.seeker_id, r.application_id) : undefined;

  if (action === "no") {
    close("dismiss");
    await answer();
    await mark(t.pressedNo);
  } else if (action === "off") {
    close("dismiss");
    const group = groupOf(r.kind);
    if (group) turnOff(db, r.seeker_id, group, now);
    await answer();
    await mark(t.pressedOff);
  } else if (STAGE_OF[action] && a) {
    const stage = STAGE_OF[action]!;
    patchApplication(db, r.seeker_id, a.id, { stage }, "seeker", now);
    close("done");
    planReminders(db, r.seeker_id, now);
    await answer();
    await mark(t.pressedStage(cap(t.stages[stage])));
  } else if (action === "wait") {
    close("done");
    await answer();
    await mark(t.pressedWait);
  } else if (action === "late" && a?.interview_at) {
    if (!lateLimit.take(String(r.seeker_id), now)) return void (await answer(t.lateAgain));
    // Готовый текст «Опаздываю»: номер или чат из поста ищем только сейчас и нигде не храним
    const profile = getProfile(db, r.seeker_id);
    const text = t.lateText(profile?.name ?? seeker!.first_name, timeLabel(Date.parse(a.interview_at)), titleOf(a, lang));
    const button = await writeButton(deps, a, text, t, t.lateSend);
    await answer();
    await call("sendMessage", {
      chat_id: r.seeker_id,
      text: `${t.lateIntro}\n\n${text}`,
      link_preview_options: { is_disabled: true },
      ...(button ? { reply_markup: { inline_keyboard: [[button]] } } : {}),
    });
  } else if (action === "video") {
    close("done");
    await answer();
    await mark(t.pressedDone);
    await hooks.videoPrompt(r.seeker_id, lang);
  } else if (action === "done") {
    close("done");
    await answer();
    await mark(t.pressedDone);
  } else if (action === "snooze") {
    const until = snoozeTime(now);
    actOn(db, r.seeker_id, r.id, { kind: "snooze", until }, now);
    await answer();
    const when = Math.round((localDayStart(until) - localDayStart(now)) / DAY_MS) === 0 ? `в ${timeLabel(until)}` : dateTimeLabel(until, lang);
    await mark(t.pressedSnooze(lang === "kk" ? when.replace(/^в /, "") : when));
  } else {
    await answer();
  }
}

/** Пункт списка: «Официант, Кафе «Луна»». */
const line = (a: Pick<ApplicationRow, "title" | "title_kk" | "employer">, lang: Lang, extra = "") =>
  `• ${titleOf(a, lang)}${a.employer ? `, ${a.employer}` : ""}${extra ? `: ${extra}` : ""}`;

/** /otkliki: отклики по группам, как во вкладке приложения, и кнопка открыть её. */
export function applicationsMessage(deps: BotDeps, userId: number, fallbackLang: Lang): Message {
  const db = deps.db;
  const now = deps.now();
  const seeker = getSeeker(db, userId);
  const lang = seeker?.lang ?? fallbackLang;
  const t = T[lang];
  const profile = seeker ? getProfile(db, userId) : undefined;
  if (!seeker || !profile) {
    return { text: t.noProfile, keyboard: [[{ text: t.createProfile, web_app: { url: appUrl(deps, { tab: "profile" }) } }]] };
  }
  const apps = db.prepare("SELECT * FROM applications WHERE seeker_id = ? ORDER BY updated_at DESC").all(userId) as unknown as ApplicationRow[];
  const open = { text: t.openApps, web_app: { url: appUrl(deps, { tab: "applications", city: profile.city }) } };
  const interviews = apps
    .filter((a) => a.stage === "interview" || a.stage === "invited")
    .sort((x, y) => (x.interview_at ?? "9") < (y.interview_at ?? "9") ? -1 : 1);
  const work = apps.filter((a) => a.stage === "offer" || a.stage === "hired");
  const waiting = apps.filter((a) => a.stage === "sent" || a.stage === "seen");
  const liked = apps.filter((a) => a.stage === "liked").length;
  if (!interviews.length && !work.length && !waiting.length && !liked) return { text: t.appsEmpty, keyboard: [[open]] };
  const section = (title: string, items: ApplicationRow[], extra: (a: ApplicationRow) => string) => {
    if (!items.length) return "";
    const shown = items.slice(0, 5).map((a) => line(a, lang, extra(a)));
    if (items.length > 5) shown.push(`• ${t.more(items.length - 5)}`);
    return `${title}\n${shown.join("\n")}`;
  };
  const when = (ms: number) => `${dayWord(ms, now, lang)}${lang === "kk" ? "," : " в"} ${timeLabel(ms)}`;
  const parts = [
    t.appsTitle,
    section(t.groups.interviews, interviews, (a) =>
      a.interview_at && Date.parse(a.interview_at) > now - 2 * 3_600_000 ? t.interviewAt(when(Date.parse(a.interview_at))) : t.stages[a.stage],
    ),
    section(t.groups.work, work, (a) => (a.start_at ? t.startAt(dateLabel(Date.parse(`${a.start_at}T12:00:00Z`), lang)) : t.stages[a.stage])),
    section(t.groups.waiting, waiting, (a) => t.stages[a.stage]),
    liked ? t.likedCount(liked) : "",
  ];
  return { text: parts.filter(Boolean).join("\n\n"), keyboard: [[open]] };
}

/** /napominaniya: что ждёт сегодня, завтра и позже, и кнопка открыть вкладку. */
export function remindersMessage(deps: BotDeps, userId: number, fallbackLang: Lang): Message {
  const db = deps.db;
  const now = deps.now();
  const seeker = getSeeker(db, userId);
  const lang = seeker?.lang ?? fallbackLang;
  const t = T[lang];
  const profile = seeker ? getProfile(db, userId) : undefined;
  if (!seeker || !profile) {
    return { text: t.noProfile, keyboard: [[{ text: t.createProfile, web_app: { url: appUrl(deps, { tab: "profile" }) } }]] };
  }
  planReminders(db, userId, now);
  const active = listReminders(db, userId, now).reminders.filter((v) => v.active);
  const open = { text: t.openReminders, web_app: { url: appUrl(deps, { tab: "reminders", city: profile.city }) } };
  if (!active.length) return { text: t.remindersEmpty, keyboard: [[open]] };
  const today = localDayStart(now);
  const label = (v: ReminderView) => {
    const title = v.kind === "custom" ? (v.text ?? "") : t.kinds[v.kind];
    const app = v.application ? `: «${titleOf(v.application, lang)}»` : "";
    return `${title}${app}`;
  };
  const groups: [string, ReminderView[], (ms: number) => string][] = [
    [t.today, active.filter((v) => Date.parse(v.due_at) < today + DAY_MS), (ms) => (ms < now ? "" : timeLabel(ms))],
    [t.tomorrow, active.filter((v) => Date.parse(v.due_at) >= today + DAY_MS && Date.parse(v.due_at) < today + 2 * DAY_MS), timeLabel],
    [t.later, active.filter((v) => Date.parse(v.due_at) >= today + 2 * DAY_MS), (ms) => dateTimeLabel(ms, lang)],
  ];
  const parts = [t.remindersTitle];
  for (const [title, items, time] of groups) {
    if (!items.length) continue;
    const shown = items.slice(0, 6).map((v) => {
      const when = time(Date.parse(v.due_at));
      return `• ${when ? `${when} ` : ""}${label(v)}`;
    });
    if (items.length > 6) shown.push(`• ${t.more(items.length - 6)}`);
    parts.push(`${title}\n${shown.join("\n")}`);
  }
  return { text: parts.join("\n\n"), keyboard: [[open]] };
}

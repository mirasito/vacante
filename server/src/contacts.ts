// Контакт работодателя из исходного поста в канале: номер для WhatsApp и звонка или имя в Telegram.
// Сервер открывает пост на t.me только в момент отклика и сразу отдаёт найденное тому, кто откликается.
// Ни номер, ни имя не записываются ни в базу, ни в журнал. В открытых данных сайта их тоже нет:
// там только виды контактов (vacante/contacts.py), и правила поиска здесь те же, что там.
import { normalizePhone } from "./profile.ts";
import { localDay } from "./time.ts";

/** Пост в канале: https://t.me/almaty_jobs/123. Других адресов сервер не открывает. */
export const POST_URL = /^https:\/\/t\.me\/([A-Za-z]\w{3,31})\/(\d{1,10})$/;

// Те же выражения, что в vacante/contacts.py. В Python \w понимает и кириллицу, здесь это [\p{L}\p{N}_]
const PHONE = /(?:\+?[78][\s(-]*)?\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g;
const WHATSAPP = /whats\s?app|watsap|ватс?ап|вацап|уатсап|вотсап|wa\.me\/|api\.whatsapp\.com\/send/iu;
const USERNAME = /(?:(?<![\p{L}\p{N}_.@/])@|(?:https?:\/\/)?t\.me\/)([A-Za-z]\w{3,31})(?![\p{L}\p{N}_/])/gu;
const PROMO = /подпис|разместить ваканси|размещени[\p{L}\p{N}_]* ваканси|реклам|наш канал|поделись|жазыл/iu;
const SERVICE = new Set(["s", "share", "joinchat", "addlist", "proxy", "vacantekz_bot"]);
// Мобильные номера Казахстана: +7 70x, 747, 77x. У городских (+7 71x, 72x) WhatsApp обычно нет
const MOBILE = /^\+7(70\d|747|77\d)/;

export interface PostContacts {
  /** Номер для WhatsApp: из ссылки wa.me или первый мобильный в тексте. */
  whatsapp: string | null;
  /** Номер для звонка. */
  phone: string | null;
  /** Кому написать в Telegram, без @. */
  telegram: string | null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[name.toLowerCase()] ?? all;
  });
}

const textOf = (markup: string) => decode(markup.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim();

/**
 * Текст поста channel/post и адреса его ссылок со страницы t.me: встраиваемого поста (?embed=1)
 * или ленты канала t.me/s/… Разметка у них одна, её же разбирает vacante/sources/telegram.py.
 */
export function postParts(page: string, channel: string, post: string): { text: string; links: string[] } | null {
  const marker = page.toLowerCase().indexOf(`data-post="${channel.toLowerCase()}/${post}"`);
  if (marker < 0) return null;
  const rest = page.slice(marker);
  const next = rest.indexOf('data-post="', 11);
  const block = next > 0 ? rest.slice(0, next) : rest;
  const m = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block);
  if (!m) return null;
  const inner = m[1] ?? "";
  const links = [...inner.matchAll(/<a\s[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .filter(([, , label]) => !PROMO.test(textOf(label ?? "")))
    .map(([, href]) => decode(href ?? ""));
  return { text: textOf(inner), links };
}

/** Контакты работодателя в тексте и ссылках поста. Строки-подписи канала и сам канал не в счёт. */
export function contactsOf(text: string, links: string[], channel: string): PostContacts {
  const body = text
    .split("\n")
    .filter((line) => !PROMO.test(line))
    .join("\n");
  const own = `https://t.me/${channel.toLowerCase()}/`;
  const hrefs = links.filter((h) => !h.toLowerCase().startsWith(own) && !h.toLowerCase().startsWith("tg://"));

  const phones: string[] = [];
  const add = (raw: string) => {
    const phone = normalizePhone(raw);
    if (phone && !phones.includes(phone)) phones.push(phone);
    return phone;
  };
  let whatsapp: string | null = null;
  for (const m of body.matchAll(PHONE)) add(m[0]);
  for (const h of hrefs) {
    const wa = /wa\.me\/\+?(\d{10,12})|api\.whatsapp\.com\/send\/?\?(?:[^#]*&)?phone=\+?(\d{10,12})/i.exec(h);
    if (wa) whatsapp ??= add(wa[1] ?? wa[2] ?? "");
    else if (/^tel:/i.test(h)) add(h.slice(4).replace(/%2B/gi, "+").replace(/%20/g, " "));
  }
  whatsapp ??= phones.find((p) => MOBILE.test(p)) ?? null;

  let telegram: string | null = null;
  const names = [
    ...[...body.matchAll(USERNAME)].map((m) => m[1] ?? ""),
    ...hrefs.map((h) => /^https?:\/\/t\.me\/([A-Za-z]\w{3,31})\/?$/i.exec(h)?.[1] ?? ""),
  ];
  for (const name of names) {
    const low = name.toLowerCase();
    if (!name || low === channel.toLowerCase() || SERVICE.has(low)) continue;
    telegram = name;
    break;
  }
  return { whatsapp, phone: phones[0] ?? null, telegram };
}

export const USER_AGENT = "Mozilla/5.0 (compatible; vacante.kz-bot/0.1; +https://vacante.kz)";

/** Открывает пост на t.me и ищет в нём контакт. null, если поста нет (удалён или без текста). */
export async function fetchPostContacts(fetchImpl: typeof fetch, sourceUrl: string): Promise<PostContacts | null> {
  const m = POST_URL.exec(sourceUrl);
  if (!m) return null;
  const [, channel = "", post = ""] = m;
  const res = await fetchImpl(`https://t.me/${channel}/${post}?embed=1&mode=tme`, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "ru" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`t.me ответил ${res.status}`);
  const parts = postParts(await res.text(), channel, post);
  return parts ? contactsOf(parts.text, parts.links, channel) : null;
}

/**
 * Сколько вакансий в день человек может открыть с номером: 30. Это защищает работодателей от спама
 * и не даёт выкачать номера через сервер. Повторный запрос той же вакансии в тот же день бесплатный.
 * Счётчик живёт только в памяти и обнуляется в полночь по времени Казахстана.
 */
export class LookupLimit {
  readonly perDay: number;
  private day = "";
  private taken = new Map<number, Set<string>>();
  constructor(perDay = 30) {
    this.perDay = perDay;
  }

  take(user: number, vacancy: string, now: number): { ok: boolean; left: number } {
    const day = localDay(now);
    if (day !== this.day) {
      this.day = day;
      this.taken.clear();
    }
    let set = this.taken.get(user);
    if (!set) this.taken.set(user, (set = new Set()));
    if (!set.has(vacancy)) {
      if (set.size >= this.perDay) return { ok: false, left: 0 };
      set.add(vacancy);
    }
    return { ok: true, left: this.perDay - set.size };
  }

  /** Telegram не ответил: попытка не считается. */
  refund(user: number, vacancy: string) {
    this.taken.get(user)?.delete(vacancy);
  }
}

// Быстрое размещение: работодатель вставляет текст вакансии или ссылку на неё (hh.kz, пост в Telegram),
// бот сам раскладывает её по вопросам анкеты и спрашивает только то, чего не нашёл.
// Разбор текста здесь без сети, чтобы всё проверялось тестами; ссылки открывает fetchPasted.
import options from "./options.json" with { type: "json" };

const MAX = { title: 80, company: 80, salary: 80, schedule: 80, address: 120, details: 1000 };

// Города: и «Алматы», и «в Алмате», «Астане», «Караганде», «Усть-Каменогорске», англ. названия hh
const CITY_WORDS = [
  ["almaty", /алмат|almaty/i], ["astana", /астан|нур-султан|astana/i], ["shymkent", /шымкент|чимкент|shymkent/i],
  ["karaganda", /караганд|қарағанд|karaganda/i], ["aktobe", /актобе|ақтөбе|aktobe/i], ["atyrau", /атырау|atyrau/i],
  ["uralsk", /уральск|орал(?![а-яё])|oral|uralsk/i], ["semey", /семей|semey/i], ["ust-kamenogorsk", /усть-каменогорск|өскемен|oskemen/i],
  ["petropavlovsk", /петропавловск|petropavl/i], ["turkestan", /туркестан|түркістан/i], ["kostanay", /костанай|қостанай|kostanay/i],
  ["pavlodar", /павлодар|pavlodar/i],
];
const CITIES = new Set(options.cities.map(([slug]) => slug));

// Подписи полей в объявлениях: «Зарплата: …», «З/п — …», «График работы: …»
const LABELS = {
  title: /^(?:вакансия|должность|требуется|требуются|ищем|ищу|нужен|нужна|нужны|в поиске|позиция)(?![а-яёa-z])[\s:–—-]*/i,
  company: /^(?:компания|заведение|работодатель|организация|место работы)(?![а-яёa-z])[\s:–—-]*/i,
  salary: /^(?:зарплата|заработная плата|з\/п|зп|оплата|оклад|ставка|доход)(?![а-яёa-z])[\s:–—-]*/i,
  schedule: /^(?:график(?: работы)?|режим работы|время работы|смены?)(?![а-яёa-z])[\s:–—-]*/i,
  address: /^(?:адрес|место|локация|где)(?![а-яёa-z])[\s:–—-]*/i,
};
const MONEY = /\d[\d\s.,]*\s*(?:₸|тг|тенге|тыс|т\.|k(?![a-z])|к(?![а-яё])|000)/i;
const SCHEDULE = /\b\d\s*\/\s*\d\b|(?<![а-яё])с\s*\d{1,2}(?:[:.]\d{2})?\s*до\s*\d{1,2}|\d{1,2}[:.]\d{2}\s*[-–—]\s*\d{1,2}[:.]\d{2}|сменн|вахт|полный день|неполный день/i;
const ADDRESS = /(?:(?<![а-яё])(?:ул\.|улиц|пр\.|проспект|мкр|микрорайон|тц(?![а-яё])|трц(?![а-яё])|бц(?![а-яё])|д\.\s*\d))/i;
const COMPANY = /(?:(?<![а-яё])(?:тоо|ип|ао)\s+["«]?[^\n,.]{2,40}|(?<![а-яё])(?:кафе|ресторан|кофейн[яюи]|бар|магазин|супермаркет|пекарн[яюи]|салон|отель|гостиниц[аеу]|сеть|склад|компани[яиюей])\s+["«][^"»\n]{2,40}["»])/i;
const PHONE = /(?:\+?[78][\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2})|(?:wa\.me\/\d+)/gi;
const LINK = /https?:\/\/\S+|t\.me\/\S+|@[A-Za-z0-9_]{4,}/g;
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu;

const clean = (s) => String(s ?? "").replace(EMOJI, "").replace(/[*_~`#]+/g, "").replace(/[ \t]+/g, " ").trim();
const cut = (s, max) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const upper = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Город по тексту: slug или null. */
export function findCity(text) {
  for (const [slug, re] of CITY_WORDS) if (CITIES.has(slug) && re.test(text)) return slug;
  return null;
}

/** Текст объявления → поля анкеты, которые удалось найти (остальные не возвращаются). */
export function parseVacancy(raw) {
  const text = String(raw ?? "").replace(/\r/g, "");
  const lines = text.split("\n").map(clean).filter(Boolean);
  const out = {};
  const take = (field, value) => {
    const v = clean(value).replace(/^[\s:–—-]+|[\s.,;!:]+$/g, "");
    if (v && out[field] == null) out[field] = cut(field === "title" ? upper(v) : v, MAX[field]);
  };
  // Строки с подписью: «Зарплата: 250 000 ₸»
  for (const line of lines) {
    for (const [field, re] of Object.entries(LABELS)) {
      if (re.test(line)) {
        const rest = line.replace(re, "");
        if (rest && !(field === "title" && rest.length > 60)) take(field, rest);
        break;
      }
    }
  }
  // Без подписей: деньги, график, адрес и название заведения по виду строки
  for (const line of lines) {
    if (out.salary == null && MONEY.test(line)) take("salary", line);
    else if (out.schedule == null && SCHEDULE.test(line) && line.length <= 80) take("schedule", line);
    else if (out.address == null && ADDRESS.test(line) && line.length <= 120) take("address", line);
  }
  const company = COMPANY.exec(text);
  if (company) take("company", company[0]);
  // Должность: первая короткая строка, если подписи не было
  if (out.title == null) {
    const first = lines.find((l) => !/^(?:срочно|внимание|вакансия)[!.:\s]*$/i.test(l));
    const t = first && first.replace(/^(?:срочно[!.,:\s]*)/i, "").replace(LABELS.title, "");
    if (t && t.length <= 60 && !MONEY.test(t)) take("title", t);
  }
  // «Официант в кафе «Зерно»» → должность «Официант», заведение отдельно
  if (out.title && out.company && out.title.toLowerCase().includes(out.company.toLowerCase())) {
    const t = out.title.slice(0, out.title.toLowerCase().indexOf(out.company.toLowerCase())).replace(/\s+(?:в|во|на|для)\s*$/i, "").trim();
    if (t) out.title = upper(t.replace(/[\s,.:–—-]+$/, ""));
  }
  const city = findCity(text);
  if (city) out.city = city;
  // Подробности: весь текст без телефонов и ссылок — отклики придут в бот
  const details = lines.join("\n").replace(PHONE, "").replace(LINK, "").replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
  if (details.length >= 20) out.details = cut(details, MAX.details);
  return out;
}

/** Похоже ли сообщение на вставленную вакансию, а не на ответ на вопрос. */
export const looksPasted = (text) => {
  const t = String(text ?? "").trim();
  return !!pasteUrl(t) || t.length >= 60 || t.split("\n").filter((l) => l.trim()).length >= 3;
};

/** Ссылка на вакансию, которую бот умеет открыть: hh или пост в публичном Telegram-канале. */
export function pasteUrl(text) {
  const hh = /(?:https?:\/\/)?(?:[\w-]+\.)?hh\.(?:kz|ru)\/vacancy\/(\d+)/i.exec(text);
  if (hh) return { kind: "hh", id: hh[1] };
  const tg = /(?:https?:\/\/)?t\.me\/(?:s\/)?([A-Za-z0-9_]{4,})\/(\d+)/i.exec(text);
  if (tg) return { kind: "tg", channel: tg[1], post: tg[2] };
  const other = /https?:\/\/\S+/i.exec(text);
  return other && String(text).trim() === other[0] ? { kind: "other" } : null;
}

const stripHtml = (html) => String(html ?? "")
  .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(?:p|li|div|h\d)>/gi, "\n").replace(/<li[^>]*>/gi, "• ")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&quot;/g, "\"").replace(/&#39;|&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  .replace(/\n\s*\n+/g, "\n").trim();

function money(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Вакансия из официального API hh → поля анкеты. */
export function fromHh(v) {
  const out = {};
  if (v.name) out.title = cut(clean(v.name), MAX.title);
  if (v.employer?.name) out.company = cut(clean(v.employer.name), MAX.company);
  const s = v.salary;
  if (s && (s.from || s.to)) {
    const cur = s.currency === "KZT" || !s.currency ? "₸" : s.currency;
    const range = s.from && s.to ? `${money(s.from)}–${money(s.to)}` : s.from ? `от ${money(s.from)}` : `до ${money(s.to)}`;
    out.salary = `${range} ${cur} в месяц`;
  }
  const schedule = [v.schedule?.name, ...(v.work_schedule_by_days || []).map((d) => d.name)].filter(Boolean)[0];
  if (schedule) out.schedule = cut(clean(schedule), MAX.schedule);
  if (v.address?.raw) out.address = cut(clean(v.address.raw), MAX.address);
  const city = findCity(`${v.area?.name || ""} ${v.address?.city || ""}`);
  if (city) out.city = city;
  const details = stripHtml(v.description);
  if (details) out.details = cut(details, MAX.details);
  return out;
}

/** Открывает ссылку и возвращает поля анкеты или null, если открыть не вышло. */
export async function fetchPasted(url, fetchFn = fetch) {
  try {
    if (url.kind === "hh") {
      const r = await fetchFn(`https://api.hh.ru/vacancies/${url.id}`, {
        headers: { "HH-User-Agent": "vacante.kz/1.0 (bot)", "User-Agent": "vacante.kz/1.0 (bot)" },
      });
      return r.ok ? fromHh(await r.json()) : null;
    }
    if (url.kind === "tg") {
      const r = await fetchFn(`https://t.me/${url.channel}/${url.post}?embed=1&mode=tme`);
      if (!r.ok) return null;
      const html = await r.text();
      const m = /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(html);
      return m ? parseVacancy(stripHtml(m[1])) : null;
    }
  } catch (err) {
    console.warn(`paste ${url.kind}: ${err}`);
  }
  return null;
}

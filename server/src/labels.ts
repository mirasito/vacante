// Подписи анкеты на двух языках: для страницы профиля и сообщений бота.
// Приложение держит такие же у себя (app/src/profile/options.ts).
import type { Profile } from "./profile.ts";

export type Lang = "ru" | "kk";

const CITY: Record<string, [string, string]> = {
  almaty: ["Алматы", "Алматы"],
  astana: ["Астана", "Астана"],
  shymkent: ["Шымкент", "Шымкент"],
  karaganda: ["Караганда", "Қарағанды"],
  aktobe: ["Актобе", "Ақтөбе"],
  atyrau: ["Атырау", "Атырау"],
  aktau: ["Актау", "Ақтау"],
  pavlodar: ["Павлодар", "Павлодар"],
  "ust-kamenogorsk": ["Усть-Каменогорск", "Өскемен"],
  semey: ["Семей", "Семей"],
  kostanay: ["Костанай", "Қостанай"],
  uralsk: ["Уральск", "Орал"],
  taraz: ["Тараз", "Тараз"],
  turkestan: ["Туркестан", "Түркістан"],
  petropavlovsk: ["Петропавловск", "Петропавл"],
  kyzylorda: ["Кызылорда", "Қызылорда"],
  kokshetau: ["Кокшетау", "Көкшетау"],
  taldykorgan: ["Талдыкорган", "Талдықорған"],
};

const EXPERIENCE: Record<NonNullable<Profile["experience"]>, [string, string]> = {
  none: ["без опыта", "тәжірибесіз"],
  lt1: ["до года", "бір жылға дейін"],
  "1to3": ["1–3 года", "1–3 жыл"],
  gt3: ["больше 3 лет", "3 жылдан астам"],
};

const EMPLOYMENT: Record<Profile["employment"][number], [string, string]> = {
  full: ["полный день", "толық күн"],
  shifts: ["смены", "ауысым"],
  night: ["ночные смены", "түнгі ауысым"],
  flexible: ["гибкий график", "икемді кесте"],
  part: ["подработка", "қосымша жұмыс"],
  weekends: ["по выходным", "демалыс күндері"],
  rotation: ["вахта", "вахта"],
};

const START: Record<NonNullable<Profile["start"]>, [string, string]> = {
  today: ["сегодня", "бүгін"],
  week: ["на этой неделе", "осы аптада"],
  "2weeks": ["через 2 недели", "2 аптадан кейін"],
  later: ["позже", "кейінірек"],
};

const LANGUAGE: Record<Profile["languages"][number], [string, string]> = {
  kk: ["казахский", "қазақ тілі"],
  ru: ["русский", "орыс тілі"],
  en: ["английский", "ағылшын тілі"],
};

const JOB_TERM: Record<Profile["jobs"][number]["term"], [string, string]> = {
  lt6m: ["до полугода", "жарты жылға дейін"],
  "6to12": ["от полугода до года", "жарты жылдан бір жылға дейін"],
  "1to3": ["1–3 года", "1–3 жыл"],
  gt3: ["больше 3 лет", "3 жылдан астам"],
};

// Навыки: те же подписи, что на кнопках в приложении (app/src/profile/skills.ts)
const SKILL: Record<Profile["skills"][number], [string, string]> = {
  hot: ["Горячий цех", "Ыстық цех"],
  cold: ["Холодный цех", "Суық цех"],
  prep: ["Заготовка", "Дайындау"],
  sushi: ["Суши и роллы", "Суши мен роллдар"],
  pizza: ["Пицца", "Пицца"],
  grill: ["Мангал и гриль", "Мангал мен гриль"],
  bakery: ["Выпечка и десерты", "Нан-тоқаш пен десерттер"],
  kitchen_banquet: ["Банкетное меню", "Банкет мәзірі"],
  espresso: ["Эспрессо-машина", "Эспрессо-машина"],
  alt_brew: ["Альтернатива", "Балама қайнату"],
  latte_art: ["Латте-арт", "Латте-арт"],
  classic_cocktails: ["Классические коктейли", "Классикалық коктейльдер"],
  signature_cocktails: ["Авторские коктейли", "Авторлық коктейльдер"],
  hookah: ["Кальян", "Кальян"],
  banquets: ["Банкеты", "Банкеттер"],
  big_hall: ["Большой зал", "Үлкен зал"],
  wine: ["Винная карта", "Шарап картасы"],
  english_menu: ["Гости на английском", "Ағылшын тілді қонақтар"],
  cash: ["Касса", "Касса"],
  iiko: ["iiko", "iiko"],
  rkeeper: ["R-Keeper", "R-Keeper"],
  poster: ["Poster", "Poster"],
  display: ["Выкладка товара", "Тауарды жаю"],
  onec: ["1С", "1С"],
  receiving: ["Приёмка товара", "Тауар қабылдау"],
  own_car: ["Свой автомобиль", "Өз көлігі"],
  own_bike: ["Свой самокат или велосипед", "Өз самокаты не велосипеді"],
  knows_city: ["Хорошо знает город", "Қаланы жақсы біледі"],
  picking: ["Сборка заказов", "Тапсырыстарды жинау"],
  tsd: ["Терминал сбора данных", "Деректер жинау терминалы"],
  forklift: ["Погрузчик", "Тиегіш"],
};

const pick = (pair: [string, string] | undefined, lang: Lang, fallback = "") => (pair ? pair[lang === "kk" ? 1 : 0] : fallback);

/** Города по порядку, как в анкете. */
export const CITY_SLUGS = Object.keys(CITY);

export const cityName = (slug: string, lang: Lang) => pick(CITY[slug], lang, slug);
// Короткая анкета опыт, график и выход не спрашивает: тогда подписи нет, и страница строку не показывает
export const experienceLabel = (p: Profile, lang: Lang) => (p.experience ? pick(EXPERIENCE[p.experience], lang) : null);
export const employmentLabel = (p: Profile, lang: Lang) =>
  p.employment.length ? p.employment.map((e) => pick(EMPLOYMENT[e], lang)).join(", ") : null;
export const startLabel = (p: Profile, lang: Lang) => (p.start ? pick(START[p.start], lang) : null);
export const languagesLabel = (p: Profile, lang: Lang) => p.languages.map((l) => pick(LANGUAGE[l], lang)).join(", ");

/** 250000 → «250 000» (неразрывные пробелы, как на сайте). */
export const money = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

export function payLabel(p: Profile, lang: Lang): string | null {
  if (p.pay_from === null) return null;
  const period = p.pay_period === "shift" ? (lang === "kk" ? "ауысымына" : "за смену") : lang === "kk" ? "айына" : "в месяц";
  return lang === "kk" ? `${money(p.pay_from)} ₸ бастап, ${period}` : `от ${money(p.pay_from)} ₸ ${period}`;
}

/** Санкнижка словами: есть или оформит. Ответ «нет» работодателю не показываем. */
export function medLabel(p: Profile, lang: Lang): string | null {
  if (p.med === "yes") return lang === "kk" ? "Санитарлық кітапшасы бар" : "Санкнижка есть";
  if (p.med === "soon") return lang === "kk" ? "Санитарлық кітапшаны рәсімдейді" : "Санкнижку оформит";
  return null;
}

export function documentsLabel(p: Profile, lang: Lang): string | null {
  const docs = [
    medLabel(p, lang)?.toLowerCase() ?? null,
    p.driver ? (lang === "kk" ? "жүргізуші куәлігі" : "водительские права") : null,
  ].filter(Boolean);
  return docs.length ? docs.join(", ") : null;
}

export const skillLabel = (id: string, lang: Lang) => pick(SKILL[id as keyof typeof SKILL], lang);
export const jobTermLabel = (term: string, lang: Lang) => pick(JOB_TERM[term as keyof typeof JOB_TERM], lang);

/** +77012345678 → +7 701 234 56 78 */
export const phoneLabel = (phone: string) => phone.replace(/^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/, "+7 $1 $2 $3 $4");

// Навыки, которые в первом лице звучат неловко («хорошо знает город»): в текст для кружка не идут
const NOT_SPOKEN = new Set(["own_car", "own_bike", "knows_city"]);

/**
 * Что сказать в видеокружке: готовые фразы из анкеты самого человека, по порядку. Кто я и кем работаю,
 * где работал, что умею, когда выйду. Человек может сказать своими словами: это опора, чтобы не молчать
 * перед камерой. Показывается в приложении и в чате бота перед записью.
 */
export function videoScript(p: Profile, lang: Lang): string[] {
  const kk = lang === "kk";
  const lower = (s: string) => (s[1] && s[1] === s[1].toLowerCase() ? s[0]!.toLowerCase() + s.slice(1) : s);
  const lines = [kk ? `Сәлеметсіз бе! Менің атым ${p.name}.` : `Здравствуйте! Меня зовут ${p.name}.`];
  const roles = p.roles.map(lower).join(", ");
  lines.push(kk ? `Жұмыс іздеп жүрмін: ${roles}.` : `Ищу работу: ${roles}.`);
  const job = p.jobs[0];
  if (job) {
    const term = jobTermLabel(job.term, lang);
    lines.push(kk ? `Тәжірибем: ${job.place}, ${lower(job.role)}, ${term}.` : `Мой опыт: ${lower(job.role)} в ${job.place}, ${term}.`);
  } else if (p.experience === "none") {
    lines.push(kk ? "Тәжірибем әзірге жоқ, бірақ тез үйренемін." : "Опыта пока нет, но я быстро учусь.");
  } else if (p.experience) {
    lines.push(kk ? `Тәжірибем: ${experienceLabel(p, lang)}.` : `Опыт: ${experienceLabel(p, lang)}.`);
  }
  const skills = p.skills.filter((id) => !NOT_SPOKEN.has(id)).slice(0, 3).map((id) => lower(skillLabel(id, lang)));
  if (skills.length) lines.push(kk ? `Қолымнан келеді: ${skills.join(", ")}.` : `Умею: ${skills.join(", ")}.`);
  if (p.start && p.start !== "later") {
    lines.push(kk ? `Жұмысқа ${startLabel(p, lang)} шыға аламын.` : `Могу выйти ${startLabel(p, lang)}.`);
  }
  if (p.employment.length) {
    lines.push(kk ? `Ыңғайлы кесте: ${employmentLabel(p, lang)}.` : `Удобный график: ${employmentLabel(p, lang)}.`);
  }
  if (p.trial) lines.push(kk ? "Сынақ ауысымына шығуға дайынмын." : "Могу выйти на пробную смену.");
  lines.push(kk ? "Рақмет, жауабыңызды күтемін!" : "Спасибо, буду ждать ответа!");
  return lines;
}

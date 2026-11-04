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

const EXPERIENCE: Record<Profile["experience"], [string, string]> = {
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

const START: Record<Profile["start"], [string, string]> = {
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

const pick = (pair: [string, string] | undefined, lang: Lang, fallback = "") => (pair ? pair[lang === "kk" ? 1 : 0] : fallback);

export const cityName = (slug: string, lang: Lang) => pick(CITY[slug], lang, slug);
export const experienceLabel = (p: Profile, lang: Lang) => pick(EXPERIENCE[p.experience], lang);
export const employmentLabel = (p: Profile, lang: Lang) => p.employment.map((e) => pick(EMPLOYMENT[e], lang)).join(", ");
export const startLabel = (p: Profile, lang: Lang) => pick(START[p.start], lang);
export const languagesLabel = (p: Profile, lang: Lang) => p.languages.map((l) => pick(LANGUAGE[l], lang)).join(", ");

/** 250000 → «250 000» (неразрывные пробелы, как на сайте). */
export const money = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

export function payLabel(p: Profile, lang: Lang): string | null {
  if (p.pay_from === null) return null;
  const period = p.pay_period === "shift" ? (lang === "kk" ? "ауысымына" : "за смену") : lang === "kk" ? "айына" : "в месяц";
  return lang === "kk" ? `${money(p.pay_from)} ₸ бастап, ${period}` : `от ${money(p.pay_from)} ₸ ${period}`;
}

export function documentsLabel(p: Profile, lang: Lang): string | null {
  const docs = [
    p.med_book ? (lang === "kk" ? "санитарлық кітапша" : "санкнижка") : null,
    p.driver ? (lang === "kk" ? "жүргізуші куәлігі" : "водительские права") : null,
  ].filter(Boolean);
  return docs.length ? docs.join(", ") : null;
}

/** +77012345678 → +7 701 234 56 78 */
export const phoneLabel = (phone: string) => phone.replace(/^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/, "+7 $1 $2 $3 $4");

// Аккуратный текст вакансии сразу, ещё в черновике: работодатель видит в предпросмотре уже поправленный вариант.
// Только форма, без новых фактов: пробелы, заглавные буквы, капс, «₸» и тысячи в зарплате, «09:00–18:00»,
// «ул.», кавычки-ёлочки, лишние «!!!». Смысл и грамматику целиком потом проверяет агент-модератор
// (.claude/skills/moderate-vacancies), он видит и вакансии, которые ждут оплаты.
// Без сети и базы, чтобы проверялось тестами.

import options from "./options.json" with { type: "json" };

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu;
const upper = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const spaces = (s) => String(s ?? "").replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").trim();

// Строка капсом («ТРЕБУЕТСЯ ОФИЦИАНТ») → обычными буквами; короткие слова капсом (KFC, ТОО) не трогаем
function decaps(s) {
  const letters = s.replace(/[^\p{L}]/gu, "");
  const caps = letters.replace(/[^\p{Lu}]/gu, "");
  if (letters.length < 8 || caps.length / letters.length < 0.8) return s;
  return upper(s.toLowerCase()).replace(/(^|[.!?]\s+)(\p{Ll})/gu, (_, a, b) => a + b.toUpperCase());
}

const thousands = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/** Должность: «ТРЕБУЕТСЯ ОФИЦИАНТ!!!» → «Официант». */
export function tidyTitle(s) {
  let v = spaces(String(s ?? "").replace(EMOJI, "").replace(/\n/g, " "));
  v = v.replace(/^(?:срочно[!.,:\s]*)?(?:требуются|требуется|нужны|нужна|нужен|ищем|ищу|в поиске|вакансия)[\s:!,–—-]+/i, "");
  v = v.replace(/[\s!.,;:]+$/g, "");
  return upper(decaps(v));
}

/** Название: пробелы и кавычки-ёлочки, капс оставляем (бывают KFC, DODO). */
export function tidyCompany(s) {
  let v = spaces(String(s ?? "").replace(EMOJI, "").replace(/\n/g, " ")).replace(/[\s.,;!]+$/g, "");
  v = v.replace(/"([^"]+)"/g, "«$1»").replace(/'([^']+)'/g, "«$1»");
  return upper(v);
}

/** Зарплата: «250000тг» → «250 000 ₸», «200-300 тыс» → «200 000–300 000 ₸». */
export function tidySalary(s) {
  let v = spaces(String(s ?? "").replace(EMOJI, "").replace(/\n/g, " "));
  // «200-300 тыс», «от 150 тыс» → полные суммы
  v = v.replace(/(\d+)\s*[-–—]\s*(\d+)\s*(?:тыс\.?|т\.(?=\s|$)|k(?![a-z])|к(?![а-яё]))/gi, (_, a, b) => `${a}000–${b}000 ₸`);
  v = v.replace(/(\d+)\s*(?:тыс\.?|k(?![a-z])|к(?![а-яё]))(?!\p{L})/giu, (_, a) => `${a}000 ₸`);
  // Валюта: тг, тенге, kzt, т. → ₸
  v = v.replace(/\s*(?:тенге|тг\.?|kzt|т\.)(?!\p{L})/giu, " ₸");
  // Тысячи пробелами: 250000 → 250 000 (и 250.000 / 250,000)
  v = v.replace(/(\d{1,3})[.,](\d{3})(?!\d)/g, "$1$2").replace(/\d{4,}/g, thousands);
  // Диапазон через короткое тире, ₸ один раз в конце диапазона
  v = v.replace(/(\d[\d ]*\d|\d)\s*₸?\s*[-–—]\s*(\d)/g, "$1–$2");
  v = v.replace(/(\d)\s*₸/g, "$1 ₸").replace(/₸(?:\s*₸)+/g, "₸");
  // Сумма без валюты, если это похоже на деньги (больше 999)
  if (!/₸|\$|€|руб|%/i.test(v)) v = v.replace(/(\d{1,3}(?: \d{3})+)(?![\d ]*₸)/, "$1 ₸");
  v = v.replace(/\s+/g, " ").replace(/[\s.,;!]+$/g, "");
  return upper(decaps(v)).replace(/^От /, "от ").replace(/^До /, "до ");
}

const hhmm = (h, m = "00") => `${String(Number(h)).padStart(2, "0")}:${m}`;

/** График: «с 9 до 18», «9.00-18.00» → «09:00–18:00». */
export function tidySchedule(s) {
  let v = spaces(String(s ?? "").replace(EMOJI, "").replace(/\n/g, ", "));
  v = v.replace(/(?<!\d)(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})(?!\d)/g, (_, a, b, c, d) => `${hhmm(a, b)}–${hhmm(c, d)}`);
  v = v.replace(/(?<![\p{L}\d])с\s*(\d{1,2})(?:[:.](\d{2}))?\s*(?:ч\.?\s*)?до\s*(\d{1,2})(?:[:.](\d{2}))?(?:\s*ч\.?)?(?!\d)/giu,
    (_, a, b, c, d) => (Number(a) <= 24 && Number(c) <= 24 ? `${hhmm(a, b)}–${hhmm(c, d)}` : _));
  v = v.replace(/(?<!\d)(\d)\s*(?:\/|на|-)\s*(\d)(?!\d)(?=\s|,|$)/g, "$1/$2");
  return upper(decaps(v.replace(/[\s.,;!]+$/g, "")));
}

// Город в адресе лишний: в карточке он и так стоит первым («Алматы, ул. Сункар, 39»)
const CITY_NAMES = options.cities.map(([, name]) => name).concat(["Нур-Султан"]);
const CITY_EDGE = new RegExp(`^(?:г\\.?\\s*)?(?:${CITY_NAMES.join("|")})(?:[\\s,]+|$)|[\\s,]+(?:г\\.?\\s*)?(?:${CITY_NAMES.join("|")})\\.?$`, "gi");

/** Адрес: «ул сункар 39, Алматы» → «ул. Сункар, 39». */
export function tidyAddress(s) {
  let v = spaces(String(s ?? "").replace(EMOJI, "").replace(/\n/g, ", ")).replace(CITY_EDGE, "").trim();
  v = v.replace(/(?<![\p{L}])(ул|пр|мкр|просп|пр-т|д|г)\.?\s+(?=\p{L}|\d)/giu, (_, w) => `${w.toLowerCase()}. `);
  v = v.replace(/(ул\.|пр\.|просп\.) (\p{Ll})/gu, (_, a, b) => `${a} ${b.toUpperCase()}`);
  v = v.replace(/(\p{L}{3,}) (\d+[\p{L}]?(?:\/\d+)?)$/u, "$1, $2");
  v = v.replace(/"([^"]+)"/g, "«$1»");
  return decaps(v.replace(/[\s.;!]+$/g, ""));
}

/** Подробности: пробелы, пустые строки, «!!!», строки капсом, единые пункты списка. */
export function tidyDetails(s) {
  let v = String(s ?? "").replace(/\r/g, "");
  v = v.split("\n").map((line) => {
    let l = spaces(line);
    l = l.replace(/^[-*•·–—]\s*/, "• ");
    l = l.replace(/([!?])\1+/g, "$1").replace(/\.{4,}/g, "…").replace(/\s+([,.!?;:])/g, "$1").replace(/([,;:])(?=\p{L})/gu, "$1 ");
    l = decaps(l);
    return l.startsWith("• ") ? l : upper(l);
  }).join("\n");
  v = v.replace(/\n{3,}/g, "\n\n").trim();
  return v ? upper(v) : v;
}

const TIDY = { title: tidyTitle, company: tidyCompany, salary: tidySalary, schedule: tidySchedule, address: tidyAddress, details: tidyDetails };

// Подписи полей для «Поправили: …»
export const FIELD_NAMES = { title: "должность", company: "название", salary: "зарплата", schedule: "график", address: "адрес", details: "описание" };

/** Поля вакансии → { job: поправленные, changed: [какие поля поменялись] }. Пустые и null не трогаем. */
export function tidyJob(job) {
  const next = { ...job };
  const changed = [];
  for (const [field, fn] of Object.entries(TIDY)) {
    const before = job[field];
    if (before == null || before === "") continue;
    if (job.kind === "shift" && field === "schedule") continue; // у смены график собирает бот из дня и времени
    const after = fn(before);
    if (after && after !== before) {
      next[field] = after;
      changed.push(field);
    }
  }
  return { job: next, changed };
}

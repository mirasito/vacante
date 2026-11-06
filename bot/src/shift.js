// Смены: работодатель за минуту публикует смену на конкретный день (/smena), соискатель жмёт «Беру смену»,
// работодатель подтверждает, бот напоминает о смене, а после неё спрашивает, кто пришёл.
// Из отметок «Пришёл» складывается надёжность соискателя: её видит следующий работодатель.
// Здесь только тексты, даты и разбор ответов, без сети и базы, чтобы всё проверялось тестами.
import { esc } from "./employer.js";
import options from "./options.json" with { type: "json" };

const CITY = Object.fromEntries(options.cities);
const LOCAL_MS = 5 * 3600e3; // время Казахстана UTC+5
const DAY_MS = 24 * 3600e3;
export const NEED = [1, 2, 3, 4, 5, 10];
export const DAYS_AHEAD = 7; // на сколько дней вперёд можно разместить смену
export const REMIND_HOURS = 3; // за сколько часов до начала напоминаем (будильник раз в час)
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

// Дата по времени Казахстана: «2026-11-07»
export function localDay(now = new Date(), plusDays = 0) {
  return new Date(now.getTime() + LOCAL_MS + plusDays * DAY_MS).toISOString().slice(0, 10);
}

// «пт, 07.11»; сегодня и завтра словами
export function dayLabel(date, now = new Date()) {
  const d = new Date(`${date}T00:00:00Z`);
  const short = `${WEEKDAYS[d.getUTCDay()]}, ${date.slice(8, 10)}.${date.slice(5, 7)}`;
  if (date === localDay(now)) return `сегодня, ${short}`;
  if (date === localDay(now, 1)) return `завтра, ${short}`;
  return short;
}

// Начало и конец смены в UTC. Конец раньше начала значит, что смена заканчивается на следующий день
export function shiftTimes(j) {
  const at = (hhmm, plus = 0) => new Date(Date.parse(`${j.shift_date}T${hhmm}:00Z`) - LOCAL_MS + plus);
  const start = at(j.shift_start);
  let end = at(j.shift_end);
  if (end <= start) end = new Date(end.getTime() + DAY_MS);
  return { start, end };
}

// «10:00–22:00», «с 9 до 18», «22.00 - 06.00» → { start: "10:00", end: "22:00" } или null
export function parseTime(text) {
  const m = /(\d{1,2})(?:[:.](\d{2}))?\s*(?:-|–|—|до)\s*(\d{1,2})(?:[:.](\d{2}))?/.exec(String(text || ""));
  if (!m) return null;
  const hh = (h, mm) => (Number(h) <= 24 && Number(mm || 0) < 60 ? `${String(Number(h) % 24).padStart(2, "0")}:${mm || "00"}` : null);
  const start = hh(m[1], m[2]);
  const end = hh(m[3], m[4]);
  return start && end && start !== end ? { start, end } : null;
}

// Строка «Смена: завтра, пт, 07.11, 10:00–22:00»: её же сохраняем в schedule, чтобы карточка была понятной везде
export function when(j, now = new Date()) {
  return `${dayLabel(j.shift_date, now)}, ${j.shift_start}–${j.shift_end}`;
}

export function scheduleText(j) {
  const date = `${j.shift_date.slice(8, 10)}.${j.shift_date.slice(5, 7)}`;
  return `Смена ${date}, ${j.shift_start}–${j.shift_end}`;
}

// Вопросы анкеты смены по порядку (как STEPS в employer.js). shift_start задаёт и время конца
export const SHIFT_STEPS = [
  { field: "city", ask: "В каком городе смена?" },
  { field: "title", ask: "Кто нужен? Например «Официант», «Грузчик» или «Помощник повара».", max: 80 },
  { field: "company", ask: "Как называется заведение или компания?", max: 80 },
  { field: "shift_date", ask: "Когда смена?" },
  { field: "shift_start", ask: "Во сколько начало и конец? Например «10:00–22:00» или «с 9 до 18».", max: 40 },
  { field: "salary", ask: "Сколько платите за смену? Например «12 000 ₸ за смену, оплата в конце дня».", max: 80 },
  { field: "need", ask: "Сколько человек нужно?" },
  { field: "address", ask: "Где работать? Улица и дом или ТЦ.", max: 120 },
  {
    field: "details",
    ask: "Что ещё важно: обязанности, форма одежды, питание, как оплачиваете. Одним сообщением. Телефон писать не нужно.",
    max: 600,
    optional: true,
  },
];

export const SHIFT_INTRO =
  "Найдём людей на смену бесплатно: смена появится на vacante.kz в разделе «Подработка и смены», " +
  "в приложении и в подборках тем, кто ищет подработку. Кто хочет выйти, нажмёт «Беру смену», " +
  "а вы подтвердите одной кнопкой. Это пара минут.";

function rows(buttons, perRow) {
  const out = [];
  for (let i = 0; i < buttons.length; i += perRow) out.push(buttons.slice(i, i + perRow));
  return out;
}

// Кнопки вопросов «Когда смена?» и «Сколько человек?»
export function shiftButtons(field, now = new Date()) {
  if (field === "shift_date") {
    const days = Array.from({ length: DAYS_AHEAD }, (_, i) => localDay(now, i));
    return rows(days.map((d) => ({ text: dayLabel(d, now), callback_data: `jobdate:${d}` })), 2);
  }
  if (field === "need") return [NEED.map((n) => ({ text: String(n), callback_data: `jobneed:${n}` }))];
  return [];
}

export function validDate(date, now = new Date()) {
  return Array.from({ length: DAYS_AHEAD }, (_, i) => localDay(now, i)).includes(date);
}

// Карточка смены
export function shiftCard(j, now = new Date()) {
  const place = [CITY[j.city] || "Казахстан", j.address].filter(Boolean).join(", ");
  const lines = [
    `⚡ <b>Смена: ${esc(j.title)}</b>`,
    `🏢 ${esc(j.company)}`,
    `📅 ${esc(when(j, now))}`,
    `📍 ${esc(place)}`,
    `💰 <b>${esc(j.salary)}</b>`,
  ];
  if (j.need) lines.push(`👥 Нужно: ${j.need} ${people(j.need)}`);
  if (j.details) lines.push("", esc(j.details));
  return lines.join("\n");
}

// «1 человек», «2 человека», «5 человек»
export function people(n) {
  return n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14) ? "человека" : "человек";
}

// Надёжность: { came, total } по отметкам работодателей → строка или ""
export function reliability(r) {
  if (!r || !r.total) return "новичок на vacante, отметок о сменах пока нет";
  return `вышел на ${r.came} из ${r.total} ${r.total === 1 ? "смены" : "смен"} через vacante`;
}

export const TAKE_LINK = (botUsername, id) => `https://t.me/${botUsername}?start=take_${id}`;

export function takeIntro(j, now = new Date()) {
  return (
    `${shiftCard(j, now)}\n\n` +
    "Чтобы взять смену, отправьте номер кнопкой внизу: работодатель увидит его и подтвердит. " +
    "Можно и написать пару слов о себе текстом, номер тогда укажите в сообщении."
  );
}

// Просьба кандидата у работодателя
export function takeRequest(j, a, from, text, phone, rel, now = new Date()) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") + (from.username ? ` (@${from.username})` : "");
  const link = from.username ? "" : `\n<a href="tg://user?id=${from.id}">Написать</a>`;
  return {
    text:
      `🙋 Хочет выйти на смену «${esc(j.title)}», ${esc(when(j, now))}\n\n` +
      (text ? `${esc(String(text).slice(0, 500))}\n\n` : "") +
      `👤 ${esc(name)}${phone ? `, 📱 ${esc(phone)}` : ""}${link}\n⭐ ${esc(reliability(rel))}`,
    keyboard: [[
      { text: "✅ Беру", callback_data: `sh:ok:${a.id}` },
      { text: "Не подходит", callback_data: `sh:no:${a.id}` },
    ]],
  };
}

export function decidedLine(status) {
  return { confirmed: "✅ Подтвердили", declined: "Отказали", cancelled: "Кандидат отменил", asked: "" }[status] || "";
}

export function confirmedText(j, botUsername, now = new Date()) {
  return {
    text:
      `✅ Вас ждут на смене!\n\n${shiftCard(j, now)}\n\n` +
      `За ${REMIND_HOURS} часа до начала напомню. Если не сможете прийти, нажмите кнопку ниже: работодатель успеет найти замену, ` +
      "а ваша надёжность не пострадает.\n\n" +
      `Нужен ещё кто-то? Позовите друга: ${TAKE_LINK(botUsername, j.id)}`,
  };
}

export const cancelButton = (a) => [[{ text: "Не смогу прийти", callback_data: `sh:cancel:${a.id}` }]];

export function declinedText(j, siteUrl) {
  return (
    `На смену «${esc(j.title)}» работодатель уже нашёл людей. Другие смены и подработка: ` +
    `${siteUrl}/${j.city}/smeny/\n\nПрисылать новые смены по вашему городу: /smeny`
  );
}

export function fullText(j) {
  return (
    `👥 На смену «${esc(j.title)}» набрали всех: ${j.need} ${people(j.need)}. ` +
    "Мы сняли её с сайта, новых просьб не будет. Если кто-то отменит, смена снова откроется сама.\n\nСмены: /myjobs"
  );
}

export function cancelledText(j, from) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  return `⚠️ ${esc(name)} не сможет прийти на смену «${esc(j.title)}», ${esc(when(j))}. Смена снова открыта для других.`;
}

export function remindText(j, now = new Date()) {
  return `⏰ Напоминаю: скоро смена.\n\n${shiftCard(j, now)}\n\nНе получается прийти? Нажмите кнопку, чтобы работодатель успел найти замену.`;
}

// После смены работодатель отмечает, кто пришёл. apps: [{id, name, attended}]
export function attendanceScreen(j, apps, now = new Date()) {
  const keyboard = apps.map((a) =>
    a.attended == null
      ? [
        { text: `✅ ${a.name || "Кандидат"} пришёл`, callback_data: `att:1:${a.id}` },
        { text: "❌ Не пришёл", callback_data: `att:0:${a.id}` },
      ]
      : [{ text: `${a.attended ? "✅" : "❌"} ${a.name || "Кандидат"}: ${a.attended ? "пришёл" : "не пришёл"}`, callback_data: "att:done" }],
  );
  return {
    text:
      `Как прошла смена «${esc(j.title)}», ${esc(when(j, now))}? Отметьте, кто пришёл: ` +
      "так следующие работодатели увидят, на кого можно положиться. Людям, которые пришли, засчитаем смену.",
    keyboard,
  };
}

export function attendedText(j, rel) {
  return `🙌 Смена «${esc(j.title)}» засчитана! Ваша надёжность: ${reliability(rel)}.\n\nЕщё смены: /smeny`;
}

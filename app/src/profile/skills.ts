// Навыки и документы кнопками: что показать человеку, решают его профессии.
// Список навыков тот же, что на сервере (server/src/profile.ts SKILLS, подписи в labels.ts);
// совпадение проверяет tests/test_server_lists.py. Новая сфера — новая группа здесь, без нового экрана.
import type { JobTerm, Med, Skill } from '../server';
import type { Lang } from '../types';

type Text = { ru: string; kk: string };

export const SKILL_LABEL: Record<Skill, Text> = {
  hot: { ru: 'Горячий цех', kk: 'Ыстық цех' },
  cold: { ru: 'Холодный цех', kk: 'Суық цех' },
  prep: { ru: 'Заготовка', kk: 'Дайындау' },
  sushi: { ru: 'Суши и роллы', kk: 'Суши мен роллдар' },
  pizza: { ru: 'Пицца', kk: 'Пицца' },
  grill: { ru: 'Мангал и гриль', kk: 'Мангал мен гриль' },
  bakery: { ru: 'Выпечка и десерты', kk: 'Нан-тоқаш пен десерттер' },
  kitchen_banquet: { ru: 'Банкетное меню', kk: 'Банкет мәзірі' },
  espresso: { ru: 'Эспрессо-машина', kk: 'Эспрессо-машина' },
  alt_brew: { ru: 'Альтернатива', kk: 'Балама қайнату' },
  latte_art: { ru: 'Латте-арт', kk: 'Латте-арт' },
  classic_cocktails: { ru: 'Классические коктейли', kk: 'Классикалық коктейльдер' },
  signature_cocktails: { ru: 'Авторские коктейли', kk: 'Авторлық коктейльдер' },
  hookah: { ru: 'Кальян', kk: 'Кальян' },
  banquets: { ru: 'Банкеты', kk: 'Банкеттер' },
  big_hall: { ru: 'Большой зал', kk: 'Үлкен зал' },
  wine: { ru: 'Винная карта', kk: 'Шарап картасы' },
  english_menu: { ru: 'Гости на английском', kk: 'Ағылшын тілді қонақтар' },
  cash: { ru: 'Касса', kk: 'Касса' },
  iiko: { ru: 'iiko', kk: 'iiko' },
  rkeeper: { ru: 'R-Keeper', kk: 'R-Keeper' },
  poster: { ru: 'Poster', kk: 'Poster' },
  display: { ru: 'Выкладка товара', kk: 'Тауарды жаю' },
  onec: { ru: '1С', kk: '1С' },
  receiving: { ru: 'Приёмка товара', kk: 'Тауар қабылдау' },
  own_car: { ru: 'Свой автомобиль', kk: 'Өз көлігім' },
  own_bike: { ru: 'Свой самокат или велосипед', kk: 'Өз самокатым не велосипедім' },
  knows_city: { ru: 'Хорошо знаю город', kk: 'Қаланы жақсы білемін' },
  picking: { ru: 'Сборка заказов', kk: 'Тапсырыстарды жинау' },
  tsd: { ru: 'Терминал сбора данных', kk: 'Деректер жинау терминалы' },
  forklift: { ru: 'Погрузчик', kk: 'Тиегіш' },
};

/** Группа навыков: кому её показать (по слову в названии профессии) и что в ней. */
interface Group {
  id: string;
  title: Text;
  match: RegExp;
  skills: Skill[];
}

const KITCHEN = /повар|сушист|пицц|пекар|кондитер|заготов|мангал|шашлы|кухон|донер|шаурм|су-шеф|шеф|аспаз|наубай/i;
const BARISTA = /бариста/i;
const BAR = /бармен|кальян/i;
const FLOOR = /официант|хостес|раннер|администратор|менеджер зала|даяшы/i;
const RETAIL = /продав|кассир|мерчендайз|сатушы/i;
const DELIVERY = /курьер|водител|доставк|экспедитор|жүргізуші/i;
const WAREHOUSE = /грузчик|кладовщик|комплектов|сборщик|склад|жүк/i;
// Общепит целиком: для него прячем вахту и водительские права
const HORECA = new RegExp(
  [KITCHEN, BARISTA, BAR, FLOOR].map((r) => r.source).join('|') + '|посудомой|мойщи|уборщи|гардероб|кассир',
  'i',
);

export const SKILL_GROUPS: Group[] = [
  { id: 'kitchen', title: { ru: 'Кухня', kk: 'Асүй' }, match: KITCHEN, skills: ['hot', 'cold', 'prep', 'sushi', 'pizza', 'grill', 'bakery', 'kitchen_banquet'] },
  { id: 'barista', title: { ru: 'Кофе', kk: 'Кофе' }, match: BARISTA, skills: ['espresso', 'alt_brew', 'latte_art'] },
  { id: 'bar', title: { ru: 'Бар', kk: 'Бар' }, match: BAR, skills: ['classic_cocktails', 'signature_cocktails', 'hookah'] },
  { id: 'floor', title: { ru: 'Зал', kk: 'Зал' }, match: FLOOR, skills: ['banquets', 'big_hall', 'wine', 'english_menu'] },
  {
    id: 'systems',
    title: { ru: 'Касса и программы', kk: 'Касса және бағдарламалар' },
    match: new RegExp([KITCHEN, BARISTA, BAR, FLOOR, RETAIL].map((r) => r.source).join('|'), 'i'),
    skills: ['cash', 'iiko', 'rkeeper', 'poster'],
  },
  { id: 'retail', title: { ru: 'Магазин', kk: 'Дүкен' }, match: RETAIL, skills: ['display', 'onec', 'receiving'] },
  { id: 'delivery', title: { ru: 'Доставка', kk: 'Жеткізу' }, match: DELIVERY, skills: ['own_car', 'own_bike', 'knows_city'] },
  { id: 'warehouse', title: { ru: 'Склад', kk: 'Қойма' }, match: WAREHOUSE, skills: ['picking', 'tsd', 'forklift'] },
];

/** Группы навыков для этих профессий. Уже отмеченные навыки не теряются, даже если профессию сменили. */
export function groupsFor(roles: string[], picked: Skill[] = []): Group[] {
  return SKILL_GROUPS.filter((g) => roles.some((r) => g.match.test(r)) || g.skills.some((sk) => picked.includes(sk)));
}

/** Все профессии человека — общепит: вахта и водительские права ему ни к чему. */
export const isHoreca = (roles: string[]) => roles.length > 0 && roles.every((r) => HORECA.test(r));
/** Санкнижку спрашиваем у тех, кто работает с едой. */
export const needsMed = (roles: string[]) => roles.some((r) => HORECA.test(r) || RETAIL.test(r));
/** Права спрашиваем у доставки и водителей, и у всех, кто не из общепита. */
export const asksDriver = (roles: string[]) => !isHoreca(roles);

export const skillLabel = (id: Skill, lang: Lang) => SKILL_LABEL[id]?.[lang] ?? id;

export const JOB_TERMS: { value: JobTerm; ru: string; kk: string }[] = [
  { value: 'lt6m', ru: 'До полугода', kk: 'Жарты жылға дейін' },
  { value: '6to12', ru: 'Полгода – год', kk: 'Жарты жыл – бір жыл' },
  { value: '1to3', ru: '1–3 года', kk: '1–3 жыл' },
  { value: 'gt3', ru: 'Больше 3 лет', kk: '3 жылдан астам' },
];

export const MED_OPTIONS: { value: Med; ru: string; kk: string }[] = [
  { value: 'yes', ru: 'Есть', kk: 'Бар' },
  { value: 'soon', ru: 'Оформлю', kk: 'Рәсімдеймін' },
  { value: 'no', ru: 'Нет', kk: 'Жоқ' },
];

/** Районы городов, где они есть: человек выбирает район сам, и только тогда его видит работодатель. */
export const DISTRICTS: Record<string, string[]> = {
  almaty: [
    'Алатауский район', 'Алмалинский район', 'Ауэзовский район', 'Бостандыкский район',
    'Жетысуский район', 'Медеуский район', 'Наурызбайский район', 'Турксибский район',
  ],
  astana: ['район Алматы', 'район Байконыр', 'район Есиль', 'район Нура', 'район Сарыарка'],
};

/** Горит ли «ищу работу сейчас»: сервер гасит её через 30 дней после последнего подтверждения. */
export const LOOKING_DAYS = 30;
export const isLooking = (lookingAt: string | null | undefined, now = Date.now()) =>
  !!lookingAt && now - Date.parse(lookingAt) < LOOKING_DAYS * 86_400_000;

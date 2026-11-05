import type { Category, City, Lang, Vacancy } from './types';

const UI = {
  ru: {
    chooseLang: 'Язык',
    chooseCity: 'Выберите город',
    vacancies: 'вакансий',
    feed: 'Рядом',
    liked: 'Избранное',
    all: 'Все',
    like: 'Сохранить',
    skip: 'Скрыть',
    undo: 'Вернуть',
    hint: 'Смахните карточку вправо — сохранить и откликнуться, влево — скрыть. Нажмите, чтобы прочитать всё.',
    hintOk: 'Понятно',
    homeText: 'Добавьте Vacante на главный экран телефона, чтобы открывать одним нажатием.',
    homeAdd: 'Добавить',
    loading: 'Загружаем вакансии…',
    error: 'Нет связи с сервером.',
    retry: 'Попробовать снова',
    endTitle: 'Вы посмотрели все вакансии',
    endText: 'Новые появляются каждый час. Загляните позже или посмотрите избранное.',
    showSkipped: 'Показать пропущенные ещё раз',
    emptyLiked: 'Смахните вакансию вправо, и она появится здесь.',
    apply: 'Откликнуться',
    share: 'Отправить другу',
    remove: 'Убрать',
    onMap: 'На карте',
    onSite: 'Открыть на сайте',
    close: 'Закрыть',
    urgent: '🔥 Срочно',
    left: 'осталось',
    shareText: 'Смотри, вакансия для тебя:',
    city: 'Город',
    min: 'мин назад',
    hours: 'ч назад',
    days: 'дн. назад',
    now: 'только что',
    near: 'Рядом с домом',
    nearEmptyTitle: 'Рядом с домом вакансий нет',
    nearEmptyText:
      'Расстояние видно только у вакансий, где указан точный адрес работы. Выберите больше километров или посмотрите все вакансии.',
    nearAll: 'Показать все вакансии',
    back: 'Назад',
    settings: 'Настройки',
    filters: 'Фильтры',
    locDenied: 'Доступ к геопозиции не дали. Его можно включить в настройках Telegram или браузера.',
    locFailed: 'Не получилось определить место. Попробуйте ещё раз.',
    noneTitle: 'По фильтрам ничего нет',
    noneText: 'Новые вакансии появляются каждый час. Пришлём подходящие в Telegram или ослабьте фильтры.',
    subscribe: 'Пришлём, когда появится',
    resetFilters: 'Сбросить фильтры',
    aboutVenue: 'О заведении',
    schedule: 'График',
    fromHome: 'От дома',
    posted: 'Опубликовано',
    perks: 'Условия',
    about: 'Описание',
    safety:
      'Работодатель не вправе просить деньги за обучение, форму или медкнижку. Просят заплатить — не платите и не отправляйте предоплату.',
    swipeTip: '← скрыть  ·  сохранить →',
  },
  kk: {
    chooseLang: 'Тіл',
    chooseCity: 'Қалаңызды таңдаңыз',
    vacancies: 'бос орын',
    feed: 'Маңайда',
    liked: 'Таңдаулылар',
    all: 'Барлығы',
    like: 'Сақтау',
    skip: 'Жасыру',
    undo: 'Қайтару',
    hint: 'Карточканы оңға сырғытыңыз — сақтап, өтінім жіберу, солға — жасыру. Толық оқу үшін басыңыз.',
    hintOk: 'Түсінікті',
    homeText: 'Vacante-ні телефонның басты экранына қосыңыз, сонда бір басумен ашылады.',
    homeAdd: 'Қосу',
    loading: 'Бос орындар жүктелуде…',
    error: 'Сервермен байланыс жоқ.',
    retry: 'Қайталау',
    endTitle: 'Барлық бос орындарды қарап шықтыңыз',
    endText: 'Жаңалары әр сағат сайын шығады. Кейінірек кіріңіз немесе таңдаулыларды қараңыз.',
    showSkipped: 'Өткізілгендерді қайта көрсету',
    emptyLiked: 'Бос орынды оңға сырғытыңыз, ол осында пайда болады.',
    apply: 'Өтінім жіберу',
    share: 'Досыңа жіберу',
    remove: 'Алып тастау',
    onMap: 'Картада',
    onSite: 'Сайтта ашу',
    close: 'Жабу',
    urgent: '🔥 Шұғыл',
    left: 'қалды',
    shareText: 'Қара, саған лайық жұмыс:',
    city: 'Қала',
    min: 'мин бұрын',
    hours: 'сағ бұрын',
    days: 'күн бұрын',
    now: 'жаңа ғана',
    near: 'Үйге жақын',
    nearEmptyTitle: 'Үйге жақын бос орын жоқ',
    nearEmptyText:
      'Қашықтық жұмыстың нақты мекенжайы көрсетілген бос орындарда ғана көрінеді. Көбірек километр таңдаңыз немесе барлық бос орындарды қараңыз.',
    nearAll: 'Барлық бос орындарды көрсету',
    back: 'Артқа',
    settings: 'Баптаулар',
    filters: 'Сүзгілер',
    locDenied: 'Геолокацияға рұқсат берілмеді. Оны Telegram немесе браузер баптауларында қосуға болады.',
    locFailed: 'Орынды анықтау мүмкін болмады. Қайталап көріңіз.',
    noneTitle: 'Сүзгі бойынша ештеңе жоқ',
    noneText: 'Жаңа бос орындар әр сағат шығады. Лайықтыларын Telegram-ға жібереміз немесе сүзгілерді азайтыңыз.',
    subscribe: 'Шыққанда хабарлаймыз',
    resetFilters: 'Сүзгілерді тазалау',
    aboutVenue: 'Мекеме туралы',
    schedule: 'Кесте',
    fromHome: 'Үйден',
    posted: 'Жарияланды',
    perks: 'Шарттар',
    about: 'Сипаттама',
    safety:
      'Жұмыс беруші оқу, жұмыс киімі немесе медкітапша үшін ақша сұрауға құқылы емес. Төлем сұраса — төлемеңіз және алдын ала ақша аудармаңыз.',
    swipeTip: '← жасыру  ·  сақтау →',
  },
};

export type Key = keyof typeof UI.ru;

export const t = (lang: Lang, key: Key) => UI[lang][key];

/** Радиус фильтра «Рядом с домом»: «до 5 км». */
export const upToKm = (km: number, lang: Lang) => (lang === 'kk' ? `${km} км-ге дейін` : `до ${km} км`);

/** «Вы вошли как Айгерим»: в казахском имя стоит в начале. */
export const signedIn = (lang: Lang, name: string) =>
  lang === 'kk' ? `${name} ретінде кірдіңіз` : `Вы вошли как ${name}`;

/** «12 вакансий», «1 вакансия»; по-казахски число не меняет слово. */
export function count(n: number, lang: Lang): string {
  if (lang === 'kk') return `${n} бос орын`;
  const d = n % 10;
  const dd = n % 100;
  const word = d === 1 && dd !== 11 ? 'вакансия' : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? 'вакансии' : 'вакансий';
  return `${n} ${word}`;
}

export const title = (v: Vacancy, lang: Lang) => (lang === 'kk' && v.title_kk) || v.title;
export const pay = (v: Vacancy, lang: Lang) => (lang === 'kk' ? v.pay_kk : v.pay) ?? v.pay;
export const monthly = (v: Vacancy, lang: Lang) => (lang === 'kk' ? v.monthly_kk : v.monthly) ?? v.monthly;
export const perks = (v: Vacancy, lang: Lang) => (lang === 'kk' ? v.perks_kk : v.perks) ?? v.perks ?? [];
export const cityName = (c: City, lang: Lang) => (lang === 'kk' ? c.name_kk : c.name);
export const categoryName = (c: Category, lang: Lang) => (lang === 'kk' ? c.name_kk : c.name);

export function age(iso: string, lang: Lang, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (minutes < 5) return t(lang, 'now');
  if (minutes < 60) return `${minutes} ${t(lang, 'min')}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${t(lang, 'hours')}`;
  return `${Math.round(hours / 24)} ${t(lang, 'days')}`;
}

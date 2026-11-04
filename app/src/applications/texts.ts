// Тексты отклика и вкладки «Отклики» на двух языках. Готовый текст сообщения с профилем
// собирает сервер (server/src/applications.ts), здесь только короткий текст без профиля.
import type { Method, SearchStage, Stage } from '../server';
import type { Lang } from '../types';
import { almaty, MONTHS } from '../profile/texts';

/** 1 отклик, 2 отклика, 5 откликов. */
export function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const RU = {
  tab: 'Отклики',
  sheetTitle: 'Как откликнуться?',
  preparing: 'Готовим текст…',
  message: 'Сообщение работодателю',
  messageHint: 'Можно поправить перед отправкой',
  withLink: 'Добавить ссылку на мой профиль',
  withLinkHint: 'Работодатель откроет профиль, а вы узнаете, что его посмотрели',
  noProfileTitle: 'С профилем отвечают охотнее',
  noProfileText: 'Сделайте профиль за 2 минуты: работодатель увидит вас по ссылке, а Vacante подскажет, когда профиль открыли.',
  makeProfile: 'Сделать профиль',
  methods: {
    whatsapp: '💬 WhatsApp',
    call: '📞 Позвонить',
    telegram: '✈️ Telegram',
    bot: '🤖 Откликнуться через Vacante',
    hh: 'Открыть на hh.kz',
    post: 'Открыть пост',
  } as Record<Method, string>,
  site: 'Открыть объявление',
  later: 'Позже',
  searching: 'Ищем контакт в посте…',
  foundTitle: 'Контакт из поста',
  foundNote: 'Номер мы не сохраняем: берём его из поста только сейчас, для вашего отклика.',
  openWhatsapp: '💬 Открыть WhatsApp с текстом',
  callNow: '📞 Позвонить',
  copyNumber: 'Скопировать номер',
  openChat: (name: string) => `✈️ Написать @${name}`,
  back: '← Назад',
  copied: 'Текст скопирован: вставьте его в чат.',
  numberCopied: 'Номер скопирован.',
  linkCopied: 'Ссылка на профиль скопирована: вставьте её в сопроводительное письмо.',
  noContact: 'В посте не нашли контакт. Откройте пост и откликнитесь там.',
  limit: 'Сегодня вы уже открыли 30 вакансий с номером. Это защита работодателей от спама: завтра снова можно, а сейчас откройте пост.',
  failed: 'Не получилось открыть пост. Попробуйте ещё раз или откройте его сами.',
  confirm: {
    whatsapp: 'Сообщение отправлено?',
    telegram: 'Сообщение отправлено?',
    call: 'Дозвонились?',
    hh: 'Откликнулись на hh.kz?',
    bot: 'Отклик в боте отправлен?',
    post: 'Откликнулись?',
  } as Record<Method, string>,
  confirmText: 'Отметим отклик во вкладке «Отклики», чтобы следить за ответом.',
  yes: 'Да, отправлено',
  no: 'Нет, ещё нет',
  doneTitle: 'Отклик во вкладке «Отклики»',
  doneLink: 'Когда работодатель откроет ссылку на профиль, бот вам напишет.',
  doneNoLink: 'Отмечайте там ответы работодателя: так видно, что дальше.',
  doneLocal: 'Отклик сохранён на этом телефоне.',
  ok: 'Готово',
  openTracker: 'Открыть «Отклики»',
  saveError: 'Не получилось сохранить. Проверьте интернет и попробуйте ещё раз.',

  stages: {
    liked: 'Нравится',
    sent: 'Отправлен',
    seen: 'Просмотрен',
    invited: 'Пригласили',
    interview: 'Собеседование',
    offer: 'Предложили работу',
    hired: 'Работаю здесь',
    rejected: 'Отказ',
    no_answer: 'Нет ответа',
    not_interested: 'Уже не интересно',
  } as Record<Stage, string>,
  search: {
    looking: 'Смотрю',
    applying: 'Откликаюсь',
    interviews: 'Собеседования',
    choosing: 'Выбираю',
    working: 'Работаю',
  } as Record<SearchStage, string>,
  week: (sent: number, seen: number, invited: number) =>
    [
      `За неделю: ${sent} ${plural(sent, 'отклик', 'отклика', 'откликов')}`,
      seen ? `${seen} посмотрели` : '',
      invited ? `${invited} ${plural(invited, 'приглашение', 'приглашения', 'приглашений')}` : '',
    ]
      .filter(Boolean)
      .join(', '),
  nextInterview: (date: string) => `Собеседование ${date}`,
  groups: {
    interviews: 'Собеседования',
    waiting: 'Ждут ответа',
    liked: 'Нравится',
    work: 'Работа',
    closed: 'Завершённые',
  },
  showClosed: (n: number) => `Показать завершённые (${n})`,
  hideClosed: 'Скрыть завершённые',
  empty: 'Смахните вакансию вправо, и она появится здесь.',
  localTitle: 'Отклики пока только на этом телефоне',
  localText: 'С профилем работодатель увидит вас по ссылке, а стадии будут меняться сами.',
  next: {
    apply: 'Откликнуться',
    again: 'Написать ещё раз',
    contact: 'Позвонить или написать',
    setInterview: 'Указать дату собеседования',
    how: 'Как прошло?',
    map: '🗺 На карте',
    setStart: 'Указать день выхода',
    hired: '✓ Работаю здесь',
  },
  status: {
    liked: (d: string) => `Нравится с ${d}`,
    sent: (d: string) => `Отправлен ${d}`,
    seen: (d: string) => `Профиль открыли ${d}`,
    interview: (d: string) => `Собеседование ${d}`,
    start: (d: string) => `Выход на работу ${d}`,
    waiting: 'Ждём ответа',
  },
  detail: {
    stage: 'Стадия',
    interview: 'Собеседование',
    day: 'День',
    time: 'Время',
    save: 'Сохранить',
    clear: 'Убрать дату',
    start: 'День выхода на работу',
    note: 'Заметка',
    notePlaceholder: 'Например, имя того, кто звонил',
    history: 'История',
    by: { seeker: 'вы', employer: 'работодатель', system: 'Vacante' },
    link: 'Ссылка на профиль в этом отклике',
    views: (n: number) => `Работодатель открывал профиль ${n} ${plural(n, 'раз', 'раза', 'раз')}`,
    openVacancy: 'Открыть вакансию',
    openPost: 'Открыть пост',
    remove: 'Удалить отклик',
    removeConfirm: 'Удалить отклик? Ссылка на профиль из него перестанет открываться.',
    removeLocal: 'Удалить отклик?',
    yes: 'Удалить',
    no: 'Отмена',
    via: (m: string) => `Способ: ${m}`,
    methods: {
      whatsapp: 'WhatsApp',
      telegram: 'Telegram',
      call: 'звонок',
      hh: 'hh.kz',
      bot: 'бот Vacante',
      post: 'пост в канале',
    } as Record<Method, string>,
  },
  how: {
    title: 'Как прошло собеседование?',
    offer: 'Предложили работу',
    wait: 'Жду ответа',
    reject: 'Отказали',
  },
  today: 'сегодня',
  tomorrow: 'завтра',
  at: 'в',
  weekdays: ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'],
  shortText: (title: string, name: string) => `Здравствуйте! Пишу по вакансии «${title}». Меня зовут ${name}.`,
};

const KK: typeof RU = {
  tab: 'Өтінімдер',
  sheetTitle: 'Қалай өтінім жіберу керек?',
  preparing: 'Мәтін дайындалуда…',
  message: 'Жұмыс берушіге хабарлама',
  messageHint: 'Жібермес бұрын түзетуге болады',
  withLink: 'Профилімнің сілтемесін қосу',
  withLinkHint: 'Жұмыс беруші профильді ашады, ал сіз оның қаралғанын білесіз',
  noProfileTitle: 'Профиль болса, жиірек жауап береді',
  noProfileText: '2 минутта профиль жасаңыз: жұмыс беруші сізді сілтеме арқылы көреді, ал Vacante профиль қашан ашылғанын айтады.',
  makeProfile: 'Профиль жасау',
  methods: {
    whatsapp: '💬 WhatsApp',
    call: '📞 Қоңырау шалу',
    telegram: '✈️ Telegram',
    bot: '🤖 Vacante арқылы өтінім жіберу',
    hh: 'hh.kz-те ашу',
    post: 'Постты ашу',
  },
  site: 'Хабарландыруды ашу',
  later: 'Кейінірек',
  searching: 'Посттан байланыс іздеп жатырмыз…',
  foundTitle: 'Посттағы байланыс',
  foundNote: 'Нөмірді сақтамаймыз: оны тек қазір, сіздің өтініміңіз үшін посттан аламыз.',
  openWhatsapp: '💬 WhatsApp-ты мәтінмен ашу',
  callNow: '📞 Қоңырау шалу',
  copyNumber: 'Нөмірді көшіру',
  openChat: (name: string) => `✈️ @${name} жазу`,
  back: '← Артқа',
  copied: 'Мәтін көшірілді: оны чатқа қойыңыз.',
  numberCopied: 'Нөмір көшірілді.',
  linkCopied: 'Профиль сілтемесі көшірілді: оны ілеспе хатқа қойыңыз.',
  noContact: 'Посттан байланыс табылмады. Постты ашып, сол жерде өтінім жіберіңіз.',
  limit: 'Бүгін нөмірі бар 30 бос орынды аштыңыз. Бұл жұмыс берушілерді спамнан қорғайды: ертең тағы болады, ал қазір постты ашыңыз.',
  failed: 'Постты ашу мүмкін болмады. Қайталап көріңіз немесе оны өзіңіз ашыңыз.',
  confirm: {
    whatsapp: 'Хабарлама жіберілді ме?',
    telegram: 'Хабарлама жіберілді ме?',
    call: 'Хабарластыңыз ба?',
    hh: 'hh.kz-те өтінім жібердіңіз бе?',
    bot: 'Боттағы өтінім жіберілді ме?',
    post: 'Өтінім жібердіңіз бе?',
  },
  confirmText: 'Жауапты бақылау үшін өтінімді «Өтінімдер» бөлімінде белгілейміз.',
  yes: 'Иә, жіберілді',
  no: 'Жоқ, әлі емес',
  doneTitle: 'Өтінім «Өтінімдер» бөлімінде',
  doneLink: 'Жұмыс беруші профиль сілтемесін ашқанда, бот сізге жазады.',
  doneNoLink: 'Жұмыс берушінің жауаптарын сонда белгілеңіз: келесі қадам көрініп тұрады.',
  doneLocal: 'Өтінім осы телефонда сақталды.',
  ok: 'Дайын',
  openTracker: '«Өтінімдерді» ашу',
  saveError: 'Сақтау мүмкін болмады. Интернетті тексеріп, қайталап көріңіз.',

  stages: {
    liked: 'Ұнайды',
    sent: 'Жіберілді',
    seen: 'Қаралды',
    invited: 'Шақырды',
    interview: 'Сұхбат',
    offer: 'Жұмыс ұсынды',
    hired: 'Осында жұмыс істеймін',
    rejected: 'Бас тартты',
    no_answer: 'Жауап жоқ',
    not_interested: 'Енді қызық емес',
  },
  search: {
    looking: 'Қараймын',
    applying: 'Өтінім жіберемін',
    interviews: 'Сұхбаттар',
    choosing: 'Таңдаймын',
    working: 'Жұмыс істеймін',
  },
  week: (sent: number, seen: number, invited: number) =>
    [`Осы аптада: ${sent} өтінім`, seen ? `${seen} қаралды` : '', invited ? `${invited} шақыру` : '']
      .filter(Boolean)
      .join(', '),
  nextInterview: (date: string) => `Сұхбат: ${date}`,
  groups: {
    interviews: 'Сұхбаттар',
    waiting: 'Жауап күтуде',
    liked: 'Ұнайды',
    work: 'Жұмыс',
    closed: 'Аяқталғандар',
  },
  showClosed: (n: number) => `Аяқталғандарды көрсету (${n})`,
  hideClosed: 'Аяқталғандарды жасыру',
  empty: 'Бос орынды оңға сырғытыңыз, ол осында пайда болады.',
  localTitle: 'Өтінімдер әзірге тек осы телефонда',
  localText: 'Профиль болса, жұмыс беруші сізді сілтеме арқылы көреді, ал кезеңдер өздігінен ауысады.',
  next: {
    apply: 'Өтінім жіберу',
    again: 'Тағы жазу',
    contact: 'Қоңырау шалу немесе жазу',
    setInterview: 'Сұхбат күнін көрсету',
    how: 'Қалай өтті?',
    map: '🗺 Картада',
    setStart: 'Жұмысқа шығу күнін көрсету',
    hired: '✓ Осында жұмыс істеймін',
  },
  status: {
    liked: (d: string) => `${d} бастап ұнайды`,
    sent: (d: string) => `Жіберілді: ${d}`,
    seen: (d: string) => `Профиль ашылды: ${d}`,
    interview: (d: string) => `Сұхбат: ${d}`,
    start: (d: string) => `Жұмысқа шығу: ${d}`,
    waiting: 'Жауап күтеміз',
  },
  detail: {
    stage: 'Кезең',
    interview: 'Сұхбат',
    day: 'Күні',
    time: 'Уақыты',
    save: 'Сақтау',
    clear: 'Күнін алып тастау',
    start: 'Жұмысқа шығу күні',
    note: 'Жазба',
    notePlaceholder: 'Мысалы, қоңырау шалған адамның аты',
    history: 'Тарих',
    by: { seeker: 'сіз', employer: 'жұмыс беруші', system: 'Vacante' },
    link: 'Осы өтінімдегі профиль сілтемесі',
    views: (n: number) => `Жұмыс беруші профильді ${n} рет ашты`,
    openVacancy: 'Бос орынды ашу',
    openPost: 'Постты ашу',
    remove: 'Өтінімді жою',
    removeConfirm: 'Өтінімді жоясыз ба? Ондағы профиль сілтемесі енді ашылмайды.',
    removeLocal: 'Өтінімді жоясыз ба?',
    yes: 'Жою',
    no: 'Бас тарту',
    via: (m: string) => `Тәсілі: ${m}`,
    methods: {
      whatsapp: 'WhatsApp',
      telegram: 'Telegram',
      call: 'қоңырау',
      hh: 'hh.kz',
      bot: 'Vacante боты',
      post: 'арнадағы пост',
    },
  },
  how: {
    title: 'Сұхбат қалай өтті?',
    offer: 'Жұмыс ұсынды',
    wait: 'Жауап күтемін',
    reject: 'Бас тартты',
  },
  today: 'бүгін',
  tomorrow: 'ертең',
  at: '',
  weekdays: ['Жс', 'Дс', 'Сс', 'Ср', 'Бс', 'Жм', 'Сб'],
  shortText: (title: string, name: string) =>
    `Сәлеметсіз бе! «${title}» бос орны бойынша жазып отырмын. Менің атым ${name}.`,
};

export const A: Record<Lang, typeof RU> = { ru: RU, kk: KK };

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (t: { year: number; month: number; day: number }) => t.year * 10000 + t.month * 100 + t.day;

/** «сегодня в 15:00», «завтра в 15:00», «5 ноября в 15:00» (по-казахски «5 қараша, 15:00»). */
export function whenRelative(iso: string, lang: Lang, now = Date.now()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const t = almaty(ms);
  const today = almaty(now);
  const tomorrow = almaty(now + 86_400_000);
  const time = `${pad(t.hour)}:${pad(t.minute)}`;
  const a = A[lang];
  const day =
    dayKey(t) === dayKey(today) ? a.today : dayKey(t) === dayKey(tomorrow) ? a.tomorrow : `${t.day} ${MONTHS[lang][t.month]}`;
  if (lang === 'kk') return dayKey(t) === dayKey(today) || dayKey(t) === dayKey(tomorrow) ? `${day} ${time}` : `${day}, ${time}`;
  return `${day} ${a.at} ${time}`;
}

/** «3 ноября» — день без времени. */
export function dayLabel(iso: string, lang: Lang): string {
  const ms = Date.parse(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(ms)) return iso;
  const t = iso.length === 10 ? { day: Number(iso.slice(8, 10)), month: Number(iso.slice(5, 7)) - 1 } : almaty(ms);
  return `${t.day} ${MONTHS[lang][t.month]}`;
}

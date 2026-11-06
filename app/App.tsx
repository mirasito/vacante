import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BackHandler, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { loadCity, loadIndex, loadPage, loadRole } from './src/api';
import { ApplicationsTab, type Focus } from './src/applications/ApplicationsTab';
import { ApplySheet, type Preset } from './src/applications/ApplySheet';
import { Celebrate } from './src/applications/Celebrate';
import { Booking } from './src/Booking';
import { ChatsTab } from './src/Chats';
import { InviteSheet, Locked, ReliabilityCard, ReliabilityPage, ReportSheet } from './src/Extras';
import { applyPatch, copyOf, fromLiked, localGoal, localSummary, toImport, withGoal, type GoalHistory } from './src/applications/model';
import { A } from './src/applications/texts';
import { filterCount, matches, subscribeLink, why, type Filter, type Want } from './src/feed';
import { FeedList, type Dir } from './src/FeedList';
import { Filters } from './src/Filters';
import { DEFAULT_NEAR, kmFromHome, type NearKm, type Point } from './src/geo';
import * as i18n from './src/i18n';
import { Icon, type IconName } from './src/icons';
import {
  addToHomeScreen,
  downloadFile,
  haptic,
  homeScreenStatus,
  initTelegram,
  launchApp,
  launchBeta,
  launchChat,
  launchCity,
  launchRef,
  launchTab,
  loadWebFont,
  onAppVisible,
  phoneLocation,
  openUrl,
  shareLink,
  telegram,
  useBackButton,
  whatsapp,
  type HomeScreen,
} from './src/platform';
import { Onboarding } from './src/Onboarding';
import { ProfileTab } from './src/profile/ProfileTab';
import { almaty, P } from './src/profile/texts';
import { RemindersTab, type Write } from './src/reminders/RemindersTab';
import { R } from './src/reminders/texts';
import {
  actOnReminder,
  deleteApplication,
  exportData,
  getReliability,
  importApplications,
  importGoal,
  listApplications,
  listReminders,
  patchApplication,
  putGoal,
  seenAchievements,
  setBeta,
  useReferral,
  whoAmI,
  type Account,
  type Application,
  type ApplicationPatch,
  type GoalValue,
  type Method,
  type Reliability,
  type Reminder,
  type Reminders,
  type Summary,
  type VacancyCopy,
} from './src/server';
import { read, write } from './src/storage';
import { Settings } from './src/Settings';
import { useColors, type Colors } from './src/theme';
import type { Index, Lang, Liked, Vacancy } from './src/types';
import { Button, Chip, IconCircle, LangSwitch, Loading, Logo, ModalArea, Retry, Screen, Tab, styles as ui } from './src/ui';
import { Avatar, VacancyFull } from './src/VacancyCard';
import { V } from './src/v2texts';
import { sameEmployer, VenueView } from './src/Venue';

// hint: подсказку про свайпы закрыли; home: про значок на экране телефона уже спросили;
// beta: открыли по тестовой ссылке ?startapp=beta, профиль можно создать до общего запуска;
// near: включён фильтр «Рядом с домом», радиус в километрах
type Prefs = {
  lang?: Lang;
  city?: string;
  cat?: string | null;
  hint?: boolean;
  home?: boolean;
  beta?: boolean;
  near?: NearKm | null;
  /** Ответы стартовых экранов «Кем работаешь» и «Где и когда»; onboarded — старт пройден или пропущен. */
  want?: Want;
  onboarded?: boolean;
  /** Где был телефон, когда нажали «Рядом со мной» (округлено, только на телефоне). */
  here?: Point;
  filter?: Filter;
  /** Код друга из ссылки ?startapp=ref_…: уходит на сервер, когда появится профиль. */
  ref?: string;
};
type TabName = 'feed' | 'liked' | 'applications' | 'reminders' | 'chats' | 'profile';
type Seen = Record<string, 'l' | 'r'>;

const samePoint = (a: Point | null, b: Point | null) => a?.lat === b?.lat && a?.lon === b?.lon;

const MAX_LIKED = 300;
// Значок на экран телефона предлагаем один раз, когда человек уже полистал ленту
const HOME_AFTER = 5;

// Шрифт Manrope в вебе и Mini App
loadWebFont();

export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}

function Main() {
  const c = useColors();
  const [booted, setBooted] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>({});
  const [index, setIndex] = useState<Index | null>(null);
  const [feed, setFeed] = useState<Vacancy[] | null>(null);
  /** Вакансии профессий по всему городу, сверх ленты: по названию профессии. */
  const [extra, setExtra] = useState<Record<string, Vacancy[]>>({});
  const extraCity = useRef<string | null>(null);
  /** Сколько вакансий в городе и страниц; какую страницу грузить следующей. */
  const [total, setTotal] = useState(0);
  const pages = useRef<{ city: string; next: number; last: number; busy: Promise<boolean> | null }>({ city: '', next: 2, last: 1, busy: null });
  const [seen, setSeen] = useState<Seen>({});
  const [liked, setLiked] = useState<Liked[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<TabName>('feed');
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState<Vacancy | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [locError, setLocError] = useState('');
  // Профиль открыли кнопкой «Рядом с домом», а дома ещё нет: сразу шаг «Где вы живёте?»
  const [profileStart, setProfileStart] = useState<'home' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [home, setHome] = useState<HomeScreen>('unsupported');
  const [account, setAccount] = useState<Account | null>(null);
  // Отклики на сервере (когда есть профиль) и сводка недели
  const [apps, setApps] = useState<Application[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [appsFailed, setAppsFailed] = useState(false);
  const [appsAttempt, setAppsAttempt] = useState(0);
  // Цель недели без профиля: с какой недели какая цель, на телефоне
  const [goalHistory, setGoalHistory] = useState<GoalHistory>([]);
  // С какими достижениями уже поздравили в этом запуске: сервер узнает об этом чуть позже
  const celebrated = useRef(new Set<string>());
  // Напоминания (только с профилем на сервере): что ждёт, история, счётчик и настройки
  const [reminders, setReminders] = useState<Reminders | null>(null);
  const [remindersFailed, setRemindersFailed] = useState(false);
  const [remindersAttempt, setRemindersAttempt] = useState(0);
  // Какую карточку отклика открыть: из ссылки бота или кнопкой «Перенести» в напоминании
  const [showApp, setShowApp] = useState<{ id: number; focus: Focus } | null>(null);
  // Окно «Как откликнуться?»: копия вакансии и, если есть, вакансия из ленты целиком.
  // preset — готовый текст из напоминания («Написать ещё раз», «Опаздываю»)
  const [applying, setApplying] = useState<{ copy: VacancyCopy; full?: Vacancy; preset?: Preset; onDone?(): void } | null>(
    null,
  );
  // vacante 2.0: открытая переписка, экран «Запись», надёжность, «Пригласить друга», жалоба
  const [chat, setChat] = useState<number | null>(null);
  const [booking, setBooking] = useState<Application | null>(null);
  const [reliability, setReliability] = useState<Reliability | null>(null);
  const [reliabilityOpen, setReliabilityOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [reportFor, setReportFor] = useState<Vacancy | null>(null);
  const seenCity = useRef<string | null>(null);
  // Шаг назад внутри вкладки «Профиль» (анкета); null — назад некуда, уходим в ленту
  const profileBack = useRef<(() => boolean) | null>(null);

  const lang: Lang = prefs.lang ?? 'ru';
  const city = prefs.city;
  const t = (key: i18n.Key) => i18n.t(lang, key);

  // Запуск: настройки с устройства, Telegram (язык пользователя), список городов
  useEffect(() => {
    (async () => {
      const [stored, storedLiked, storedGoal, app] = await Promise.all([
        read<Prefs>('prefs', {}),
        read<Liked[]>('liked', []),
        read<GoalHistory>('goal', []),
        initTelegram(),
      ]);
      const tgLang = app?.initDataUnsafe?.user?.language_code === 'kk' ? 'kk' : undefined;
      // Открыли по кнопке из подборки бота: сразу город этой подборки. Кнопка «Открыть профиль»
      // передаёт город профиля только на случай, если на этом устройстве город ещё не выбран
      const linkCity = launchTab() === 'profile' && stored.city ? undefined : launchCity();
      const beta = stored.beta || launchBeta();
      const ref = launchRef();
      setBeta(beta);
      setPrefs({
        ...stored,
        lang: stored.lang ?? tgLang ?? 'ru',
        ...(linkCity ? { city: linkCity } : {}),
        ...(beta ? { beta: true } : {}),
        ...(ref && !stored.ref ? { ref } : {}),
      });
      setLiked(storedLiked);
      setGoalHistory(storedGoal);
      setBooted(true);
      if (app) {
        homeScreenStatus().then(setHome);
        // Вход на сервер Vacante: пока сервера нет, просто ничего не показываем
        whoAmI().then(setAccount);
      }
    })();
  }, []);

  useEffect(() => {
    setError(false);
    loadIndex().then(setIndex, (err) => {
      // Причина видна в консоли браузера и в журнале телефона (logcat) у сборки для Android
      console.warn('Список городов не загрузился', err);
      setError(true);
    });
  }, [attempt]);

  // Города нет в ленте (старая ссылка или в нём не осталось вакансий): просим выбрать заново
  useEffect(() => {
    if (index && city && !index.cities.some((ct) => ct.slug === city)) {
      setPrefs((p) => ({ ...p, city: undefined }));
    }
  }, [index, city]);

  // Вакансии города и то, что в нём уже просмотрено
  useEffect(() => {
    if (!city) return;
    let alive = true;
    setFeed(null);
    setExtra({});
    extraCity.current = city;
    setError(false);
    seenCity.current = null;
    pages.current = { city, next: 2, last: 1, busy: null };
    Promise.all([loadCity(city), read<Seen>(`seen:${city}`, {})]).then(
      ([{ items, total, pages: last }, stored]) => {
        if (!alive) return;
        // Лента догружается страницами, поэтому просмотренное храним без сверки с первой страницей,
        // но не больше 3000 последних отметок, чтобы память не росла бесконечно
        const kept: Seen = Object.fromEntries(Object.entries(stored).slice(-3000));
        pages.current = { city, next: 2, last, busy: null };
        setTotal(total);
        seenCity.current = city;
        setSeen(kept);
        setHistory([]);
        setFeed(items);
      },
      (err) => {
        console.warn(`Вакансии города ${city} не загрузились`, err);
        if (alive) setError(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [city, attempt]);

  useEffect(() => {
    if (booted) write('prefs', prefs);
  }, [prefs, booted]);
  useEffect(() => {
    if (booted) write('liked', liked);
  }, [liked, booted]);
  useEffect(() => {
    if (booted) write('goal', goalHistory);
  }, [goalHistory, booted]);
  useEffect(() => {
    if (city && seenCity.current === city) write(`seen:${city}`, seen);
  }, [seen, city]);

  useEffect(() => {
    telegram()?.setHeaderColor?.(c.bg);
    telegram()?.setBackgroundColor?.(c.bg);
  }, [c.bg]);

  // Ушли из профиля, так и не сохранив дом: в следующий раз профиль открывается как обычно
  useEffect(() => {
    if (tab !== 'profile') setProfileStart(null);
  }, [tab]);

  // Кнопка «Назад» на Android сначала закрывает выбор города и «Избранное», а не всё приложение
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (picking && city) {
        setPicking(false);
        return true;
      }
      if (tab === 'profile' && profileBack.current?.()) return true;
      if (tab !== 'feed') {
        setTab('feed');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [picking, city, tab]);

  // В Telegram то же самое делает кнопка «Назад» в шапке, а ещё она закрывает карточку вакансии
  useBackButton(
    !!applying || !!open || filtersOpen || settingsOpen || !!booking || reliabilityOpen || inviteOpen || !!reportFor || (picking && !!city) || tab !== 'feed',
    () => {
    if (reportFor) setReportFor(null);
    else if (inviteOpen) setInviteOpen(false);
    else if (reliabilityOpen) setReliabilityOpen(false);
    else if (booking) setBooking(null);
    else if (tab === 'chats' && chat) setChat(null);
    else if (filtersOpen) setFiltersOpen(false);
    else if (settingsOpen) setSettingsOpen(false);
    else if (applying) setApplying(null);
    else if (open) setOpen(null);
    else if (picking && city) setPicking(false);
    else if (tab === 'profile' && profileBack.current?.()) return;
    else setTab('feed');
    },
  );

  // Вкладка «Профиль» видна, когда сервер ответил и профили открыты (или это тестировщик)
  const showProfile = !!account && (account.open || !!prefs.beta);
  // Отклики: на сервере, когда есть профиль; без профиля — на телефоне; без сервера — просто «Избранное»
  // «Мои» есть у всех: без профиля отклики и стадии хранятся на телефоне
  const tracker: 'off' | 'local' | 'server' = account?.profile ? 'server' : 'local';

  // Открыли кнопкой бота «Открыть профиль» (?tab=profile), из сообщения об отклике (?tab=applications)
  // или из напоминания (?tab=reminders; «Перенести» добавляет &app=<id>: сразу дата собеседования)
  const launched = useRef(false);
  useEffect(() => {
    if (!showProfile || launched.current) return;
    launched.current = true;
    const want = launchTab();
    if ((want === 'reminders' || want === 'chats') && !account.profile) return;
    if (want) setTab(want);
    if (want === 'chats') setChat(launchChat() ?? null);
    const app = launchApp();
    if (want === 'applications' && app) setShowApp({ id: app, focus: 'interview' });
  }, [showProfile, account]);

  // Отклики с сервера; заодно переносим туда то, что накопилось на телефоне до профиля
  useEffect(() => {
    if (tracker !== 'server') return;
    let alive = true;
    setAppsFailed(false);
    listApplications().then(
      (r) => {
        if (!alive) return;
        setApps(r.applications);
        setSummary(r.summary);
      },
      () => alive && setAppsFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [tracker, appsAttempt]);

  const moving = useRef(false);
  useEffect(() => {
    if (tracker !== 'server' || !liked.length || moving.current) return;
    moving.current = true;
    const batch = liked.slice(0, 300);
    importApplications(batch.map(toImport)).then(
      (r) => {
        moving.current = false;
        setApps(r.applications);
        setSummary(r.summary);
        const done = new Set(batch.map((l) => l.id));
        setLiked((list) => list.filter((l) => !done.has(l.id)));
      },
      () => {
        moving.current = false;
      },
    );
  }, [tracker, liked]);

  // Цель с телефона переносим, когда отклики уже на сервере: по ним он считает прошлые недели серии
  const movingGoal = useRef(false);
  useEffect(() => {
    if (tracker !== 'server' || !summary || liked.length || !goalHistory.length || movingGoal.current) return;
    const goal = localGoal([], goalHistory).goal;
    if (!goal) {
      setGoalHistory([]);
      return;
    }
    movingGoal.current = true;
    importGoal(goal, goalHistory).then(
      (r) => {
        movingGoal.current = false;
        setSummary(r.summary);
        setGoalHistory([]);
      },
      () => {
        movingGoal.current = false;
      },
    );
  }, [tracker, summary, liked.length, goalHistory]);

  // Напоминания с сервера: при запуске, после изменений в откликах и при переходе на вкладку
  useEffect(() => {
    if (tracker !== 'server') {
      setReminders(null);
      return;
    }
    let alive = true;
    setRemindersFailed(false);
    listReminders().then(
      (r) => alive && setReminders(r),
      () => alive && setRemindersFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [tracker, remindersAttempt]);
  const refreshReminders = useCallback(() => setRemindersAttempt((n) => n + 1), []);

  // Друг пригласил по ссылке: сервер запишет это один раз, когда появится профиль
  useEffect(() => {
    if (tracker !== 'server' || !prefs.ref) return;
    useReferral(prefs.ref).then(
      () => setPrefs((p) => ({ ...p, ref: undefined })),
      () => undefined,
    );
  }, [tracker, prefs.ref]);

  // Надёжность для карточки в профиле: при входе на вкладку и после отметки явки
  useEffect(() => {
    if (tracker !== 'server' || tab !== 'profile') return;
    getReliability().then(setReliability, () => undefined);
  }, [tracker, tab]);

  const unread = (apps ?? []).reduce((n, a) => n + (a.unread ?? 0), 0);
  const unreadRef = useRef(unread);
  unreadRef.current = unread;
  // Чаты прочитали или пришёл ответ: обновим отклики, чтобы значок на вкладке был верным
  const onUnread = useCallback((n: number) => {
    if (n !== unreadRef.current) setAppsAttempt((x) => x + 1);
  }, []);
  // На вкладке свежее: кнопки в боте меняют и напоминания, и стадии откликов
  useEffect(() => {
    if (tab === 'reminders' || tab === 'profile') refreshReminders();
    if (tab === 'applications') setAppsAttempt((n) => n + 1);
    if (tab !== 'chats') setChat(null);
  }, [tab, refreshReminders]);

  // Вернулись в приложение: работодатель мог открыть профиль или ответить, а в боте могли нажать кнопку
  useEffect(() => {
    if (tracker !== 'server') return;
    return onAppVisible(() => {
      setAppsAttempt((n) => n + 1);
      refreshReminders();
    });
  }, [tracker, refreshReminders]);

  // Стадия или дата собеседования поменялись: у отклика другие напоминания
  const putApp = useCallback(
    (a: Application, next?: Summary) => {
      setApps((list) => [a, ...(list ?? []).filter((x) => x.id !== a.id)]);
      if (next) setSummary(next);
      refreshReminders();
    },
    [refreshReminders],
  );

  const clearShowApp = useCallback(() => setShowApp(null), []);
  const localItems = useMemo(() => liked.map(fromLiked), [liked]);
  const trackerItems = tracker === 'server' ? apps : localItems;
  const trackerSummary = tracker === 'server' ? summary : localSummary(localItems, goalHistory);

  const onGoal = async (goal: GoalValue | null) => {
    if (tracker === 'server') {
      const r = await putGoal(goal);
      setSummary(r.summary);
      return;
    }
    setGoalHistory((h) => withGoal(h, goal));
  };

  // Новое достижение поздравляем один раз, когда не открыто другое окно
  const fresh = tracker === 'server' && summary ? summary.achievements.filter((a) => !a.seen && !celebrated.current.has(a.kind)) : [];
  const closeCelebrate = () => {
    for (const a of fresh) celebrated.current.add(a.kind);
    setSummary((s) => s && { ...s, achievements: s.achievements.map((a) => ({ ...a, seen: true })) });
    seenAchievements().catch(() => undefined);
  };

  /** Отклик без профиля (или сервер не ответил): на телефоне, с той же стадией. */
  const saveLocal = (copy: VacancyCopy, full: Vacancy | undefined, patch: ApplicationPatch) => {
    const now = new Date().toISOString();
    setLiked((list) => {
      const known = list.find((x) => x.id === copy.id);
      const base: Liked = known ?? {
        ...(full ?? {
          id: copy.id,
          title: copy.title,
          title_kk: copy.title_kk ?? undefined,
          employer: copy.employer ?? undefined,
          address: copy.address ?? undefined,
          map: copy.map ?? undefined,
          url: copy.url ?? '',
          source_url: copy.source_url ?? undefined,
          contact: copy.contact,
          category: 'other',
          posted_at: now,
        }),
        city: copy.city ?? city ?? '',
        liked_at: now,
      };
      return [applyPatch(base, patch, now), ...list.filter((x) => x.id !== copy.id)].slice(0, MAX_LIKED);
    });
  };

  const onSent = async (method: Method, app: Application | null) => {
    if (!applying) return;
    if (tracker === 'server' && app) {
      // «Написать ещё раз» не отматывает стадию назад
      const patch: ApplicationPatch = app.stage === 'liked' ? { stage: 'sent', method } : { method };
      const r = await patchApplication(app.id, patch);
      putApp(r.application, r.summary);
      return;
    }
    const known = liked.find((x) => x.id === applying.copy.id);
    saveLocal(applying.copy, applying.full, !known?.stage || known.stage === 'liked' ? { stage: 'sent', method } : { method });
  };

  const patchItem = async (a: Application, patch: ApplicationPatch): Promise<Application> => {
    if (a.id > 0) {
      const r = await patchApplication(a.id, patch);
      putApp(r.application, r.summary);
      return r.application;
    }
    const i = liked.findIndex((x) => x.id === a.vacancy.id);
    const item = liked[i];
    if (!item) return a;
    const next = applyPatch(item, patch);
    setLiked((list) => list.map((x) => (x.id === item.id ? next : x)));
    return fromLiked(next, i);
  };

  const removeItem = async (a: Application) => {
    if (a.id > 0) {
      const r = await deleteApplication(a.id);
      setApps((list) => (list ?? []).filter((x) => x.id !== a.id));
      setSummary(r.summary);
      refreshReminders();
      return;
    }
    setLiked((list) => list.filter((x) => x.id !== a.vacancy.id));
  };

  // Смена на день: «Беру смену» сразу в боте, там номер, подтверждение работодателя и напоминание
  const startApply = (v: Vacancy) =>
    v.shift === 'slot' && v.source_url ? openUrl(v.source_url) : city && setApplying({ copy: copyOf(v, city), full: v });

  /** Готовый текст работодателю из напоминания или «Написать ещё раз» в отклике. */
  const presetFor = (kind: Write, title: string, interviewAt?: string | null): Preset => {
    const tr = R[lang];
    if (kind === 'again') return { kicker: tr.againKicker, text: tr.followUp(title), link: true };
    const at = interviewAt ? almaty(Date.parse(interviewAt)) : null;
    const time = at ? `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}` : '';
    return { kicker: tr.lateKicker, text: tr.lateText(account?.first_name ?? '', time, title), link: false };
  };

  const writeFromReminder = (r: Reminder, kind: Write) => {
    const a = r.application;
    if (!a) return;
    const { id: _id, vacancy_id, method: _m, stage: _s, interview_at, start_at: _st, ...copy } = a;
    const title = (lang === 'kk' && a.title_kk) || a.title;
    setApplying({
      copy: { ...copy, id: vacancy_id },
      preset: presetFor(kind, title, interview_at),
      // «Опаздываю» может понадобиться ещё раз, а «Написать ещё раз» после сообщения сделано
      onDone:
        kind === 'again'
          ? () =>
              void actOnReminder(r.id, 'done').then(
                (next) => setReminders(next),
                () => undefined,
              )
          : undefined,
    });
  };
  // «Рядом»: только вакансии с точкой не дальше радиуса. Точка — дом из профиля на сервере
  // или место, где человек нажал «Рядом со мной» (хранится только на телефоне)
  const homePoint = account?.home ?? prefs.here ?? null;
  const near = homePoint && prefs.near ? prefs.near : null;
  const withinKm = useCallback(
    (v: Vacancy, km: NearKm | null) => {
      if (!km) return true;
      const d = kmFromHome(homePoint, v);
      return d !== null && d <= km;
    },
    [homePoint],
  );
  const isNear = useCallback((v: Vacancy) => withinKm(v, near), [withinKm, near]);
  const filter = useMemo(() => prefs.filter ?? {}, [prefs.filter]);
  /** Следующая страница вакансий города; false, когда страниц больше нет или город сменился. */
  const loadNext = useCallback((): Promise<boolean> => {
    const p = pages.current;
    if (!city || p.city !== city || p.next > p.last) return Promise.resolve(false);
    // Страница уже грузится (прокрутка и фильтр одновременно): ждём её, а не бросаем
    if (p.busy) return p.busy.then(() => pages.current === p && p.next <= p.last);
    const n = p.next;
    p.busy = loadPage(city, n).then(
      (items) => {
        p.busy = null;
        if (pages.current !== p) return false;
        p.next = n + 1;
        setFeed((list) => {
          const ids = new Set((list ?? []).map((v) => v.id));
          return [...(list ?? []), ...items.filter((v) => !ids.has(v.id))];
        });
        return p.next <= p.last;
      },
      () => {
        p.busy = null;
        return false;
      },
    );
    return p.busy;
  }, [city]);
  /** Все страницы: фильтры и «Рядом с домом» должны искать по всему городу. */
  const loadAll = useCallback(async () => {
    while (await loadNext()) {
      /* грузим по одной странице, пока есть */
    }
  }, [loadNext]);
  /** Подгружает файлы выбранных профессий, которых ещё нет. */
  const loadRoles = useCallback(
    (titles: string[] | undefined) => {
      if (!city || !titles?.length) return;
      for (const title of titles) {
        const key = index?.roles?.find((r) => r.title === title)?.key;
        if (!key || extra[title]) continue;
        setExtra((x) => ({ ...x, [title]: x[title] ?? [] }));
        void loadRole(city, key).then((items) => {
          if (extraCity.current === city) setExtra((x) => ({ ...x, [title]: items }));
        });
      }
    },
    [city, index, extra],
  );
  useEffect(() => loadRoles(filter.roles), [filter.roles, loadRoles]);
  /** Лента вместе с подгруженными вакансиями профессий: свежие из ленты первыми, остальные после. */
  const withExtra = useMemo(() => {
    const all = feed ?? [];
    const lists = Object.values(extra).filter((l) => l.length);
    if (!lists.length) return all;
    const ids = new Set(all.map((v) => v.id));
    const more: Vacancy[] = [];
    for (const v of lists.flat()) {
      if (ids.has(v.id)) continue;
      ids.add(v.id);
      more.push(v);
    }
    more.sort((a, b) => (b.posted_at ?? '').localeCompare(a.posted_at ?? ''));
    return [...all, ...more];
  }, [feed, extra]);
  const inCategory = useCallback((v: Vacancy) => (!prefs.cat || v.category === prefs.cat) && matches(v, filter), [prefs.cat, filter]);
  const cards = useMemo(
    () => (filter.roles?.length ? withExtra : (feed ?? [])).filter((v) => !seen[v.id] && inCategory(v) && isNear(v)),
    [feed, withExtra, filter.roles, seen, inCategory, isNear],
  );
  // Кнопка «Смены» стоит отдельно от «Фильтров», но тоже сужает ленту
  const filters = filterCount(filter) + (filter.shift ? 1 : 0);
  const sheetFilters = filterCount(filter);
  // С фильтром, сферой или «Рядом с домом» ищем по всему городу, а не по загруженным страницам
  useEffect(() => {
    if (total && (filtersOpen || filters || near || prefs.cat)) void loadAll();
  }, [total, filtersOpen, filters, near, prefs.cat, loadAll]);
  const reason = useCallback((v: Vacancy) => why(v, prefs.want, kmFromHome(homePoint, v), lang), [prefs.want, homePoint, lang]);

  /** «Рядом со мной»: место телефона, округлённое до ~100 м, остаётся только на телефоне. */
  const locate = async () => {
    const r = await phoneLocation();
    if (typeof r === 'string') return r;
    const point = { lat: Math.round(r.lat * 1000) / 1000, lon: Math.round(r.lon * 1000) / 1000 };
    setPref({ here: point });
    return point;
  };
  const locateNear = async () => {
    setLocError('');
    const r = await locate();
    if (typeof r === 'string') setLocError(t(r === 'denied' ? 'locDenied' : 'locFailed'));
    else setPref({ near: DEFAULT_NEAR });
  };
  // Рядом с домом есть вакансии, просто все уже просмотрены
  const nearSeen = useMemo(() => !!near && (feed ?? []).some((v) => inCategory(v) && isNear(v)), [near, feed, inCategory, isNear]);
  const skipped = useMemo(() => Object.values(seen).some((d) => d === 'l'), [seen]);
  const toggleNear = () => {
    haptic();
    if (near) setPref({ near: null });
    else if (homePoint) setPref({ near: DEFAULT_NEAR });
    else if (tracker === 'server') {
      // Дома в профиле ещё нет: сначала «Где вы живёте?», после сохранения сразу назад в ленту
      setProfileStart('home');
      setTab('profile');
    } else void locateNear();
  };
  const askHome =
    !prefs.home && (home === 'missed' || home === 'unknown') && Object.keys(seen).length >= HOME_AFTER;

  const onSwipe = useCallback(
    (v: Vacancy, dir: Dir) => {
      haptic(dir === 'right' ? 'medium' : 'light');
      setSeen((s) => ({ ...s, [v.id]: dir === 'right' ? 'r' : 'l' }));
      setHistory((h) => [...h.slice(-49), v.id]);
      if (dir === 'right' && city) {
        // С профилем лайк сразу становится откликом на сервере (окно «Как откликнуться?» его заводит)
        if (tracker !== 'server') {
          setLiked((list) =>
            [{ ...v, city, liked_at: new Date().toISOString() }, ...list.filter((x) => x.id !== v.id)].slice(
              0,
              MAX_LIKED,
            ),
          );
        }
        setApplying({ copy: copyOf(v, city), full: v });
      }
    },
    [city, tracker],
  );

  const undo = () => {
    const id = history[history.length - 1];
    if (!id) return;
    haptic();
    setHistory((h) => h.slice(0, -1));
    setSeen((s) => {
      const { [id]: _, ...rest } = s;
      return rest;
    });
    setLiked((list) => list.filter((x) => x.id !== id));
    // Лайк с профилем уже на сервере: убираем, если откликнуться не успели
    const app = apps?.find((a) => a.vacancy.id === id);
    if (app?.stage === 'liked') {
      deleteApplication(app.id).then(
        (r) => {
          setApps((list) => (list ?? []).filter((x) => x.id !== app.id));
          setSummary(r.summary);
        },
        () => undefined,
      );
    }
  };

  const showSkipped = () =>
    setSeen((s) => Object.fromEntries(Object.entries(s).filter(([, d]) => d === 'r')));

  const setPref = (patch: Prefs) => setPrefs((p) => ({ ...p, ...patch }));

  if (!booted) return <Loading c={c} text="" />;

  // Первый запуск: язык и город
  if (!city || picking) {
    return (
      <Screen c={c}>
        <View style={styles.pickerHead}>
          <Logo c={c} height={30} />
          <LangSwitch lang={lang} c={c} onChange={(l) => setPref({ lang: l })} />
        </View>
        {account ? (
          <Text style={[styles.account, { color: c.quiet }]}>✓ {i18n.signedIn(lang, account.first_name)}</Text>
        ) : null}
        <Text style={[ui.h1, { color: c.ink }]}>{t('chooseCity')}</Text>
        {index ? (
          <ScrollView contentContainerStyle={styles.cityList}>
            {index.cities.map((ct) => (
              <Pressable
                key={ct.slug}
                onPress={() => {
                  haptic();
                  setPref({ city: ct.slug });
                  setPicking(false);
                  setTab('feed');
                }}
                style={[
                  styles.cityRow,
                  { backgroundColor: c.card, borderColor: ct.slug === city ? c.strong : c.line },
                ]}
              >
                <View style={styles.cityLeft}>
                  <Icon name="pin" color={ct.slug === city ? c.accent : c.faint} size={20} />
                  <Text style={[styles.cityName, { color: c.ink }]}>{i18n.cityName(ct, lang)}</Text>
                </View>
                <Text style={[styles.cityCount, { color: c.quiet }]}>{i18n.count(ct.count, lang)}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : error ? (
          <Retry c={c} lang={lang} onRetry={() => setAttempt((n) => n + 1)} />
        ) : (
          <Loading c={c} text={t('loading')} />
        )}
      </Screen>
    );
  }

  // Старт из макета: «Кем работаешь» и «Где и когда». Один раз; у кого профиль, тем не нужен
  if (!prefs.onboarded && !account?.profile) {
    return (
      <Onboarding
        c={c}
        lang={lang}
        index={index}
        initial={prefs.want}
        here={prefs.here ?? null}
        near={prefs.near ?? null}
        onLang={(l) => setPref({ lang: l })}
        locate={async () => {
          const r = await locate();
          return r;
        }}
        onDone={(want, here, km) => {
          haptic();
          setPref({
            want,
            onboarded: true,
            ...(here ? { here } : {}),
            near: here ? km : null,
            filter: { ...(prefs.filter ?? {}), roles: want.roles },
          });
          setTab('feed');
        }}
      />
    );
  }

  const cityInfo = index?.cities.find((ct) => ct.slug === city);
  const subscribeUrl = city ? subscribeLink(city, prefs.cat, filter.payFrom, filter.shift) : null;
  return (
    <Screen c={c}>
      <View style={styles.header}>
        <Pressable
          onPress={() => setPicking(true)}
          hitSlop={8}
          style={styles.cityButton}
          accessibilityRole="button"
          accessibilityLabel={t('chooseCity')}
        >
          <Icon name="pin" color={c.accent} />
          <Text style={[styles.cityText, { color: c.ink }]} numberOfLines={1}>
            {cityInfo ? i18n.cityName(cityInfo, lang) : city}
            {near ? ` · ${i18n.upToKm(near, lang)}` : ''}
          </Text>
          <Icon name="down" color={c.faint} />
        </Pressable>
        <View style={styles.headerRight}>
          <LangSwitch lang={lang} c={c} onChange={(l) => setPref({ lang: l })} />
          {tracker === 'server' ? (
            <Pressable
              onPress={() => setTab('reminders')}
              hitSlop={8}
              style={styles.gear}
              accessibilityRole="button"
              accessibilityLabel={V[lang].reminders}
            >
              <Icon name="bell" color={tab === 'reminders' ? c.accent : c.ink} />
              {reminders?.due ? (
                <View style={[styles.dot, { backgroundColor: c.skip, borderColor: c.bg }]}>
                  <Text style={styles.dotText}>{reminders.due}</Text>
                </View>
              ) : null}
            </Pressable>
          ) : null}
          <Pressable
            onPress={() => setSettingsOpen(true)}
            hitSlop={8}
            style={styles.gear}
            accessibilityRole="button"
            accessibilityLabel={t('settings')}
          >
            <Icon name="settings" color={c.ink} />
          </Pressable>
        </View>
      </View>

      {tab === 'feed' ? (
        <>
          {index ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.cats}
              contentContainerStyle={styles.catsRow}
            >
              <Chip
                c={c}
                active={!!sheetFilters}
                icon="sliders"
                label={sheetFilters ? `${t('filters')} · ${sheetFilters}` : t('filters')}
                onPress={() => setFiltersOpen(true)}
              />
              <Chip
                c={c}
                active={!!filter.shift}
                label={lang === 'kk' ? '⚡ Ауысымдар' : '⚡ Смены'}
                onPress={() => setPref({ filter: { ...filter, shift: !filter.shift || undefined } })}
              />
              <Chip c={c} active={!!near} icon="home" label={near ? i18n.upToKm(near, lang) : t('near')} onPress={toggleNear} />
              <Chip c={c} active={!prefs.cat} label={t('all')} onPress={() => setPref({ cat: null })} />
              {index.categories
                .filter((cat) => feed?.some((v) => v.category === cat.slug))
                .map((cat) => (
                  <Chip
                    key={cat.slug}
                    c={c}
                    active={prefs.cat === cat.slug}
                    label={i18n.categoryName(cat, lang)}
                    onPress={() => setPref({ cat: cat.slug })}
                  />
                ))}
            </ScrollView>
          ) : null}
          {locError ? <Text style={[styles.locError, { color: c.skip }]}>{locError}</Text> : null}

          <View style={styles.deckArea}>
            {error ? (
              <Retry c={c} lang={lang} onRetry={() => setAttempt((n) => n + 1)} />
            ) : !feed ? (
              <Loading c={c} text={t('loading')} />
            ) : cards.length ? (
              <FeedList
                onEnd={() => void loadNext()}
                items={cards}
                lang={lang}
                c={c}
                home={homePoint}
                reason={reason}
                tip={!prefs.hint}
                onSwipe={onSwipe}
                onOpen={setOpen}
                onApply={startApply}
                header={
                  <View style={styles.countRow}>
                    <Text style={[styles.count, { color: c.quiet }]}>
                      {i18n.count(
                        filters || near || prefs.cat ? cards.length : Math.max(cards.length, total - Object.keys(seen).length),
                        lang,
                      )}
                      {near ? ` · ${t('near').toLowerCase()}` : ''}
                      {filters ? (lang === 'kk' ? ' · сүзгі бойынша' : ' · по фильтрам') : ''}
                    </Text>
                    {history.length ? <Chip c={c} active={false} icon="undo" label={t('undo')} onPress={undo} /> : null}
                  </View>
                }
              />
            ) : near && !nearSeen ? (
              <Empty c={c} icon="home" title={t('nearEmptyTitle')} text={t('nearEmptyText')}>
                <Button c={c} label={t('nearAll')} onPress={() => setPref({ near: null })} />
                {subscribeUrl ? <Button c={c} ghost icon="bell" label={t('subscribe')} onPress={() => openUrl(subscribeUrl)} /> : null}
              </Empty>
            ) : (
              <Empty c={c} icon="search" title={t(filters ? 'noneTitle' : 'endTitle')} text={t(filters ? 'noneText' : 'endText')}>
                {subscribeUrl ? <Button c={c} icon="bell" label={t('subscribe')} onPress={() => openUrl(subscribeUrl)} /> : null}
                {filters ? <Button c={c} ghost label={t('resetFilters')} onPress={() => setPref({ filter: {} })} /> : null}
                {skipped ? <Button c={c} ghost label={t('showSkipped')} onPress={showSkipped} /> : null}
                {near ? <Button c={c} ghost label={t('nearAll')} onPress={() => setPref({ near: null })} /> : null}
                {history.length ? <Button c={c} ghost icon="undo" label={t('undo')} onPress={undo} /> : null}
              </Empty>
            )}
            {feed && cards.length && !prefs.hint ? (
              <View style={[styles.hint, { backgroundColor: c.strong }]}>
                <Text style={[styles.hintText, { color: c.onStrong }]}>{t('hint')}</Text>
                <Pressable onPress={() => setPref({ hint: true })} hitSlop={8}>
                  <Text style={[styles.hintOk, { color: c.onStrong }]}>{t('hintOk')}</Text>
                </Pressable>
              </View>
            ) : askHome && cards.length ? (
              <View style={[styles.hint, { backgroundColor: c.strong }]}>
                <Text style={[styles.hintText, { color: c.onStrong }]}>{t('homeText')}</Text>
                <Pressable
                  onPress={() => {
                    haptic();
                    addToHomeScreen();
                    setPref({ home: true });
                  }}
                  hitSlop={8}
                >
                  <Text style={[styles.hintOk, { color: c.onStrong }]}>{t('homeAdd')}</Text>
                </Pressable>
                <Pressable onPress={() => setPref({ home: true })} hitSlop={8} accessibilityLabel={t('close')}>
                  <Icon name="close" color={c.faint} size={20} />
                </Pressable>
              </View>
            ) : null}
          </View>
        </>
      ) : tab === 'profile' && showProfile ? (
        <ProfileTab
          c={c}
          lang={lang}
          index={index}
          name={account.first_name}
          city={city}
          backRef={profileBack}
          start={profileStart ?? undefined}
          want={prefs.want}
          onHome={(point) => {
            setAccount((a) => (a && !samePoint(a.home, point) ? { ...a, home: point } : a));
            // Дом сохранили после кнопки «Рядом с домом»: назад в ленту, фильтр уже включён
            if (point && profileStart === 'home') {
              setProfileStart(null);
              setPref({ near: DEFAULT_NEAR });
              setTab('feed');
            }
          }}
          onProfile={(has) => {
            setAccount((a) => (a ? { ...a, profile: has, home: has ? a.home : null } : a));
            if (!has) {
              setApps(null);
              setSummary(null);
              setReminders(null);
            }
          }}
          reminders={
            tracker === 'server'
              ? { data: reminders, onChange: setReminders, onOpenAll: () => setTab('reminders') }
              : undefined
          }
          extra={
            tracker === 'server' ? (
              <View style={styles.extra}>
                <ReliabilityCard c={c} lang={lang} data={reliability} onOpen={() => setReliabilityOpen(true)} />
                <Button c={c} ghost icon="user" label={V[lang].invite} onPress={() => setInviteOpen(true)} />
              </View>
            ) : undefined
          }
        />
      ) : tab === 'chats' && tracker === 'server' ? (
        <ChatsTab c={c} lang={lang} open={chat} onOpen={setChat} onUnread={onUnread} />
      ) : tab === 'chats' || (tab === 'profile' && !showProfile) ? (
        <Locked
          c={c}
          lang={lang}
          what={tab === 'chats' ? 'chats' : 'profile'}
          where={!telegram() ? 'browser' : showProfile ? 'ready' : account ? 'closed' : 'offline'}
          onProfile={() => setTab('profile')}
          openUrl={openUrl}
          city={city}
          subscribeUrl={subscribeUrl}
        />
      ) : tab === 'reminders' && tracker === 'server' ? (
        <RemindersTab
          c={c}
          lang={lang}
          data={reminders}
          failed={remindersFailed}
          onRetry={refreshReminders}
          onChange={setReminders}
          onWrite={writeFromReminder}
          onOpenApplication={(id, focus) => {
            setShowApp({ id, focus });
            setTab('applications');
          }}
          onStage={async (id, stage) => {
            const r = await patchApplication(id, { stage });
            putApp(r.application, r.summary);
          }}
          onRecord={() => setTab('profile')}
          onTab={setTab}
        />
      ) : tab !== 'liked' ? (
        <ApplicationsTab
          c={c}
          lang={lang}
          items={trackerItems}
          summary={trackerSummary}
          local={tracker === 'local'}
          failed={appsFailed}
          onRetry={() => setAppsAttempt((n) => n + 1)}
          onApply={(a, again) =>
            setApplying({
              copy: a.vacancy,
              preset: again ? presetFor('again', (lang === 'kk' && a.vacancy.title_kk) || a.vacancy.title) : undefined,
            })
          }
          onPatch={patchItem}
          onDelete={removeItem}
          onGoal={onGoal}
          onMakeProfile={() => setTab('profile')}
          show={showApp}
          onShown={clearShowApp}
          onBooking={tracker === 'server' ? setBooking : undefined}
        />
      ) : (
        <LikedList
          items={liked}
          lang={lang}
          c={c}
          onOpen={setOpen}
          onRemove={(id) => setLiked((list) => list.filter((x) => x.id !== id))}
        />
      )}

      <View style={[styles.tabs, { borderColor: c.line, backgroundColor: c.card }]}>
        <Tab c={c} active={tab === 'feed'} icon="pin" label={t('feed')} onPress={() => setTab('feed')} />
        <Tab
          c={c}
          active={tab === 'applications' || tab === 'liked'}
          icon="calendar"
          label={A[lang].tab}
          badge={trackerItems?.length}
          onPress={() => setTab('applications')}
        />
        <Tab c={c} active={tab === 'chats'} icon="chat" label={V[lang].chats} badge={unread} alert onPress={() => setTab('chats')} />
        <Tab c={c} active={tab === 'profile'} icon="user" label={P[lang].tab} onPress={() => setTab('profile')} />
      </View>

      <Modal visible={!!open} animationType="slide" onRequestClose={() => setOpen(null)}>
        {/* У модального окна своя иерархия view: отступы под вырез экрана считаем заново */}
        <ModalArea>
          {open ? (
            <Details
              v={open}
              lang={lang}
              c={c}
              home={homePoint}
              all={feed ?? []}
              onOther={setOpen}
              onReport={account ? () => setReportFor(open) : undefined}
              onClose={() => setOpen(null)}
              onSave={() => {
                setOpen(null);
                onSwipe(open, 'right');
              }}
              onApply={() => {
                setOpen(null);
                startApply(open);
              }}
            />
          ) : null}
        </ModalArea>
      </Modal>
      <Modal visible={!!applying} animationType="slide" onRequestClose={() => setApplying(null)} transparent>
        <ModalArea>
          {applying ? (
            <ApplySheet
              key={`${applying.copy.id}-${applying.preset?.kicker ?? ''}`}
              preset={applying.preset}
              onDone={applying.onDone}
              c={c}
              lang={lang}
              vacancy={applying.copy}
              server={tracker === 'server'}
              name={account?.first_name ?? ''}
              onStarted={(a) => putApp(a)}
              onSent={onSent}
              onClose={() => setApplying(null)}
              onMakeProfile={() => {
                setApplying(null);
                setTab('profile');
              }}
              onOpenTracker={() => {
                setApplying(null);
                setTab('applications');
              }}
            />
          ) : null}
        </ModalArea>
      </Modal>
      <Modal visible={filtersOpen} animationType="slide" transparent onRequestClose={() => setFiltersOpen(false)}>
        <ModalArea>
          {filtersOpen ? (
            <Filters
              c={c}
              lang={lang}
              index={index}
              value={filter}
              near={near}
              canNear={!!homePoint}
              pool={(feed ?? []).filter((v) => !seen[v.id] && (!prefs.cat || v.category === prefs.cat))}
              rolePool={withExtra.filter((v) => !seen[v.id] && (!prefs.cat || v.category === prefs.cat))}
              onRoles={loadRoles}
              isNear={withinKm}
              onLocate={() => void locateNear()}
              onApply={(f, km) => {
                setPref({ filter: f, near: km });
                setFiltersOpen(false);
              }}
              onClose={() => setFiltersOpen(false)}
            />
          ) : null}
        </ModalArea>
      </Modal>
      <Modal visible={settingsOpen} animationType="slide" onRequestClose={() => setSettingsOpen(false)}>
        <ModalArea>
          {settingsOpen ? (
            <Settings
              c={c}
              lang={lang}
              subscribeUrl={subscribeUrl}
              server={tracker === 'server'}
              onLang={(l) => setPref({ lang: l })}
              onReminders={() => {
                setSettingsOpen(false);
                setTab('reminders');
              }}
              onProfile={() => {
                setSettingsOpen(false);
                setTab('profile');
              }}
              onRestart={() => {
                setSettingsOpen(false);
                setPref({ onboarded: false });
              }}
              onClear={() => {
                setSettingsOpen(false);
                setLiked([]);
                setSeen({});
                setHistory([]);
                setPrefs((p) => ({ lang: p.lang, city: p.city, beta: p.beta }));
              }}
              onClose={() => setSettingsOpen(false)}
              onInvite={() => setInviteOpen(true)}
              onExport={async () => {
                const { url } = await exportData();
                downloadFile(url, 'vacante-data.json');
              }}
            />
          ) : null}
        </ModalArea>
      </Modal>
      <Modal visible={!!booking} animationType="slide" onRequestClose={() => setBooking(null)}>
        <ModalArea>
          {booking ? (
            <Booking
              key={`${booking.id}-${booking.updated_at}`}
              c={c}
              lang={lang}
              app={booking}
              onClose={() => setBooking(null)}
              onChange={(a, rel) => {
                putApp(a);
                setBooking(a);
                if (rel) setReliability(rel);
              }}
              onChat={() => {
                setChat(booking.id);
                setBooking(null);
                setTab('chats');
              }}
              onSetTime={() => {
                setShowApp({ id: booking.id, focus: 'interview' });
                setBooking(null);
                setTab('applications');
              }}
            />
          ) : null}
        </ModalArea>
      </Modal>
      <Modal visible={reliabilityOpen} animationType="slide" onRequestClose={() => setReliabilityOpen(false)}>
        <ModalArea>{reliabilityOpen ? <ReliabilityPage c={c} lang={lang} onClose={() => setReliabilityOpen(false)} /> : null}</ModalArea>
      </Modal>
      <Modal visible={inviteOpen} animationType="slide" transparent onRequestClose={() => setInviteOpen(false)}>
        <ModalArea>{inviteOpen ? <InviteSheet c={c} lang={lang} onClose={() => setInviteOpen(false)} /> : null}</ModalArea>
      </Modal>
      <Modal visible={!!reportFor} animationType="slide" transparent onRequestClose={() => setReportFor(null)}>
        <ModalArea>
          {reportFor ? (
            <ReportSheet
              c={c}
              lang={lang}
              v={reportFor}
              onClose={() => setReportFor(null)}
              onSent={() => {
                // Вакансию, на которую пожаловались, в ленте больше не показываем
                setSeen((x) => ({ ...x, [reportFor.id]: 'l' }));
                setOpen(null);
              }}
            />
          ) : null}
        </ModalArea>
      </Modal>
      {fresh.length && !applying && !open ? <Celebrate c={c} lang={lang} list={fresh} onClose={closeCelebrate} /> : null}
      <StatusBar style="auto" />
    </Screen>
  );
}

function shareVacancy(v: Vacancy, lang: Lang, via: 'any' | 'whatsapp') {
  const pay = i18n.pay(v, lang);
  const text = `${i18n.t(lang, 'shareText')} ${i18n.title(v, lang)}${pay ? ` — ${pay}` : ''}`;
  haptic();
  return via === 'whatsapp' ? whatsapp(text, v.url) : shareLink(text, v.url);
}

/** Страница вакансии из макета: назад, «Поделиться» и «Сохранить» сверху, отклик снизу. */
function Details(props: {
  v: Vacancy;
  lang: Lang;
  c: Colors;
  home: Point | null;
  /** Вакансии города: для страницы заведения. */
  all: Vacancy[];
  onOther(v: Vacancy): void;
  onClose(): void;
  onSave(): void;
  onApply?(): void;
  /** «Пожаловаться»: только когда вошли через Telegram (жалоба уходит модератору с аккаунтом). */
  onReport?(): void;
}) {
  const { v, lang, c, onClose } = props;
  const t = (key: i18n.Key) => i18n.t(lang, key);
  const [venue, setVenue] = useState(false);
  const others = v.employer ? props.all.filter((x) => sameEmployer(x, v)).length : 0;
  const iconButton = (icon: IconName, label: string, onPress: () => void) => (
    <Pressable onPress={onPress} hitSlop={10} accessibilityRole="button" accessibilityLabel={label} style={styles.iconButton}>
      <Icon name={icon} color={c.ink} />
    </Pressable>
  );
  return (
    <SafeAreaView style={[styles.page, { backgroundColor: c.bg }]} edges={['top', 'bottom']}>
      <View style={ui.column}>
        <View style={styles.pageTop}>
          {iconButton('back', t('back'), venue ? () => setVenue(false) : onClose)}
          {venue ? null : (
            <View style={styles.pageTopRight}>
              {iconButton('share', t('share'), () => shareVacancy(v, lang, 'any'))}
              {iconButton('heart', t('like'), props.onSave)}
            </View>
          )}
        </View>
        {venue ? (
          <VenueView
            v={v}
            all={props.all}
            lang={lang}
            c={c}
            onOpen={(x) => {
              setVenue(false);
              props.onOther(x);
            }}
          />
        ) : (
          <>
            <ScrollView style={ui.flex}>
              <VacancyFull v={v} lang={lang} c={c} home={props.home} />
              {v.employer ? (
                <Pressable
                  onPress={() => setVenue(true)}
                  accessibilityRole="button"
                  style={[styles.venueCard, { borderColor: c.line, backgroundColor: c.card }]}
                >
                  <View style={ui.flex}>
                    <Text style={[styles.venueTitle, { color: c.ink }]}>{t('aboutVenue')}</Text>
                    <Text style={[styles.venueSub, { color: c.quiet }]} numberOfLines={1}>
                      {v.employer}
                      {others > 1 ? ` · ${i18n.count(others, lang)}` : ''}
                    </Text>
                  </View>
                  <Icon name="next" color={c.faint} size={20} />
                </Pressable>
              ) : null}
            </ScrollView>
            <View style={[styles.pageActions, { borderColor: c.line }]}>
              <Button c={c} label={t('apply')} onPress={props.onApply ?? (() => openUrl(v.source_url ?? v.url))} />
              <View style={styles.pageLinks}>
                <Button c={c} small ghost icon="chat" label="WhatsApp" onPress={() => shareVacancy(v, lang, 'whatsapp')} />
                {v.map ? <Button c={c} small ghost icon="map" label={t('onMap')} onPress={() => openUrl(v.map!)} /> : null}
                <Button c={c} small ghost icon="link" label={t('onSite')} onPress={() => openUrl(v.url)} />
                {props.onReport ? <Button c={c} small ghost icon="shield" label={V[lang].report} onPress={props.onReport} /> : null}
              </View>
            </View>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

/** Пустая лента: значок в сером круге, заголовок, пояснение и кнопки. */
function Empty(props: { c: Colors; icon: IconName; title: string; text: string; children?: ReactNode }) {
  const { c } = props;
  return (
    <View style={ui.center}>
      <IconCircle c={c} icon={props.icon} />
      <Text style={[ui.h2, { color: c.ink }]}>{props.title}</Text>
      <Text style={[ui.note, { color: c.quiet }]}>{props.text}</Text>
      {/* Кнопки растягиваются по ширине в ряду: здесь обёртка, чтобы не растянулись по высоте */}
      <View style={styles.endActions}>{props.children}</View>
    </View>
  );
}

function LikedList(props: {
  items: Liked[];
  lang: Lang;
  c: Colors;
  onOpen(v: Vacancy): void;
  onRemove(id: string): void;
}) {
  const { items, lang, c, onOpen, onRemove } = props;
  const t = (key: i18n.Key) => i18n.t(lang, key);
  if (!items.length) return <Empty c={c} icon="heart" title={t('liked')} text={t('emptyLiked')} />;
  return (
    <FlatList
      data={items}
      keyExtractor={(v) => v.id}
      ListHeaderComponent={<Text style={[ui.h1, styles.listTitle, { color: c.ink }]}>{t('liked')}</Text>}
      contentContainerStyle={styles.likedList}
      renderItem={({ item: v }) => (
        <Pressable
          onPress={() => onOpen(v)}
          style={[styles.likedRow, { backgroundColor: c.card, borderColor: c.line }]}
        >
          <View style={styles.likedHead}>
            <Avatar v={v} c={c} size={40} />
            <View style={ui.flex}>
              <Text style={[styles.likedTitle, { color: c.ink }]} numberOfLines={2}>
                {i18n.title(v, lang)}
              </Text>
              <Text style={[styles.likedSub, { color: c.quiet }]} numberOfLines={1}>
                {[v.employer, i18n.age(v.posted_at, lang)].filter(Boolean).join(' · ')}
              </Text>
            </View>
          </View>
          {i18n.pay(v, lang) ? <Text style={[styles.likedPay, { color: c.ink }]}>{i18n.pay(v, lang)}</Text> : null}
          <View style={ui.row}>
            <Button c={c} small label={t('apply')} onPress={() => openUrl(v.source_url ?? v.url)} />
            <Button c={c} small ghost label={t('share')} onPress={() => shareVacancy(v, lang, 'any')} />
            <Button c={c} small ghost label={t('remove')} onPress={() => onRemove(v.id)} />
          </View>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  logo: { fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  pickerHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
  },
  account: { fontSize: 13, paddingHorizontal: 20, marginTop: -4, marginBottom: 8 },
  cityList: { paddingHorizontal: 20, paddingBottom: 24, gap: 8 },
  cityRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    minHeight: 56,
    borderRadius: 14,
    borderWidth: 1,
  },
  cityLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cityName: { fontSize: 16, fontWeight: '700' },
  cityCount: { fontSize: 13, fontWeight: '600' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
  },
  cityButton: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, minHeight: 44 },
  cityText: { fontSize: 15, fontWeight: '700', flexShrink: 1 },
  cats: { flexGrow: 0 },
  catsRow: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8, gap: 8 },
  deckArea: { flex: 1 },
  countRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 36 },
  count: { fontSize: 13, fontWeight: '600' },
  endActions: { alignSelf: 'stretch', gap: 10 },
  hint: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 12,
    borderRadius: 16,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  hintText: { flex: 1, fontSize: 14, lineHeight: 19 },
  hintOk: { fontSize: 15, fontWeight: '800', textDecorationLine: 'underline' },
  tabs: { flexDirection: 'row', borderTopWidth: 1, paddingHorizontal: 8 },
  listTitle: { paddingHorizontal: 0, marginTop: 4 },
  likedList: { paddingHorizontal: 20, paddingBottom: 24, gap: 12 },
  likedRow: { padding: 16, borderRadius: 16, borderWidth: 1, gap: 10 },
  likedHead: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  likedTitle: { fontSize: 18, fontWeight: '700', lineHeight: 23 },
  likedSub: { fontSize: 13, marginTop: 2 },
  likedPay: { fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  page: { flex: 1 },
  pageTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8 },
  pageTopRight: { flexDirection: 'row', gap: 4 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  gear: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  dot: {
    position: 'absolute',
    top: 2,
    right: 0,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    paddingHorizontal: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotText: { color: '#fff', fontSize: 10, fontWeight: '800', lineHeight: 12 },
  extra: { gap: 10 },
  locError: { fontSize: 13, paddingHorizontal: 20, paddingBottom: 6 },
  venueCard: {
    marginHorizontal: 20,
    marginBottom: 20,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  venueTitle: { fontSize: 15, fontWeight: '700' },
  venueSub: { fontSize: 13, marginTop: 2 },
  pageActions: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 16, gap: 10, borderTopWidth: 1 },
  pageLinks: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
});

import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BackHandler, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { loadCity, loadIndex } from './src/api';
import { ApplicationsTab, type Focus } from './src/applications/ApplicationsTab';
import { ApplySheet, type Preset } from './src/applications/ApplySheet';
import { Celebrate } from './src/applications/Celebrate';
import { applyPatch, copyOf, fromLiked, localGoal, localSummary, toImport, withGoal, type GoalHistory } from './src/applications/model';
import { A } from './src/applications/texts';
import * as i18n from './src/i18n';
import {
  addToHomeScreen,
  haptic,
  homeScreenStatus,
  initTelegram,
  launchApp,
  launchBeta,
  launchCity,
  launchTab,
  onAppVisible,
  openUrl,
  shareLink,
  telegram,
  useBackButton,
  whatsapp,
  type HomeScreen,
} from './src/platform';
import { ProfileTab } from './src/profile/ProfileTab';
import { almaty, P } from './src/profile/texts';
import { RemindersTab, type Write } from './src/reminders/RemindersTab';
import { R } from './src/reminders/texts';
import {
  actOnReminder,
  deleteApplication,
  importApplications,
  importGoal,
  listApplications,
  listReminders,
  patchApplication,
  putGoal,
  seenAchievements,
  setBeta,
  whoAmI,
  type Account,
  type Application,
  type ApplicationPatch,
  type GoalValue,
  type Method,
  type Reminder,
  type Reminders,
  type Summary,
  type VacancyCopy,
} from './src/server';
import { read, write } from './src/storage';
import { SwipeDeck, type DeckHandle, type Dir } from './src/SwipeDeck';
import { useColors, type Colors } from './src/theme';
import type { Index, Lang, Liked, Vacancy } from './src/types';
import { Button, Chip, LangSwitch, Loading, ModalArea, Retry, Round, Screen, Tab, styles as ui } from './src/ui';
import { VacancyCard } from './src/VacancyCard';

// hint: подсказку про свайпы закрыли; home: про значок на экране телефона уже спросили;
// beta: открыли по тестовой ссылке ?startapp=beta, профиль можно создать до общего запуска
type Prefs = { lang?: Lang; city?: string; cat?: string | null; hint?: boolean; home?: boolean; beta?: boolean };
type TabName = 'feed' | 'liked' | 'applications' | 'reminders' | 'profile';
type Seen = Record<string, 'l' | 'r'>;

const MAX_LIKED = 300;
// Значок на экран телефона предлагаем один раз, когда человек уже полистал ленту
const HOME_AFTER = 5;

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
  const [seen, setSeen] = useState<Seen>({});
  const [liked, setLiked] = useState<Liked[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<TabName>('feed');
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState<Vacancy | null>(null);
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
  const deck = useRef<DeckHandle>(null);
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
      setBeta(beta);
      setPrefs({
        ...stored,
        lang: stored.lang ?? tgLang ?? 'ru',
        ...(linkCity ? { city: linkCity } : {}),
        ...(beta ? { beta: true } : {}),
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
    loadIndex().then(setIndex, () => setError(true));
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
    setError(false);
    seenCity.current = null;
    Promise.all([loadCity(city), read<Seen>(`seen:${city}`, {})]).then(
      ([items, stored]) => {
        if (!alive) return;
        // Ушедшие из ленты вакансии забываем, чтобы память не росла бесконечно
        const ids = new Set(items.map((v) => v.id));
        const kept: Seen = {};
        for (const [id, dir] of Object.entries(stored)) if (ids.has(id)) kept[id] = dir;
        seenCity.current = city;
        setSeen(kept);
        setHistory([]);
        setFeed(items);
      },
      () => alive && setError(true),
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
  useBackButton(!!applying || !!open || (picking && !!city) || tab !== 'feed', () => {
    if (applying) setApplying(null);
    else if (open) setOpen(null);
    else if (picking && city) setPicking(false);
    else if (tab === 'profile' && profileBack.current?.()) return;
    else setTab('feed');
  });

  // Вкладка «Профиль» видна, когда сервер ответил и профили открыты (или это тестировщик)
  const showProfile = !!account && (account.open || !!prefs.beta);
  // Отклики: на сервере, когда есть профиль; без профиля — на телефоне; без сервера — просто «Избранное»
  const tracker: 'off' | 'local' | 'server' = !showProfile ? 'off' : account.profile ? 'server' : 'local';

  // Открыли кнопкой бота «Открыть профиль» (?tab=profile), из сообщения об отклике (?tab=applications)
  // или из напоминания (?tab=reminders; «Перенести» добавляет &app=<id>: сразу дата собеседования)
  const launched = useRef(false);
  useEffect(() => {
    if (!showProfile || launched.current) return;
    launched.current = true;
    const want = launchTab();
    if (want === 'reminders' && !account.profile) return;
    if (want) setTab(want);
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
  // На вкладке свежее: кнопки в боте меняют и напоминания, и стадии откликов
  useEffect(() => {
    if (tab === 'reminders' || tab === 'profile') refreshReminders();
    if (tab === 'applications') setAppsAttempt((n) => n + 1);
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

  const startApply = (v: Vacancy) => city && setApplying({ copy: copyOf(v, city), full: v });

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
  const cards = useMemo(
    () => (feed ?? []).filter((v) => !seen[v.id] && (!prefs.cat || v.category === prefs.cat)),
    [feed, seen, prefs.cat],
  );
  const skipped = useMemo(() => Object.values(seen).some((d) => d === 'l'), [seen]);
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
        if (tracker !== 'off') setApplying({ copy: copyOf(v, city), full: v });
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
          <Text style={[styles.logo, { color: c.ink }]}>vacante</Text>
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
                  { backgroundColor: c.card, borderColor: ct.slug === city ? c.accent : c.line },
                ]}
              >
                <Text style={[styles.cityName, { color: c.ink }]}>{i18n.cityName(ct, lang)}</Text>
                <Text style={{ color: c.quiet }}>
                  {ct.count} {t('vacancies')}
                </Text>
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

  const cityInfo = index?.cities.find((ct) => ct.slug === city);
  return (
    <Screen c={c}>
      <View style={styles.header}>
        <Pressable onPress={() => setPicking(true)} hitSlop={8}>
          <Text style={[styles.cityButton, { color: c.ink }]}>
            📍 {cityInfo ? i18n.cityName(cityInfo, lang) : city} ▾
          </Text>
        </Pressable>
        <LangSwitch lang={lang} c={c} onChange={(l) => setPref({ lang: l })} />
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

          <View style={styles.deckArea}>
            {error ? (
              <Retry c={c} lang={lang} onRetry={() => setAttempt((n) => n + 1)} />
            ) : !feed ? (
              <Loading c={c} text={t('loading')} />
            ) : cards.length ? (
              <SwipeDeck ref={deck} items={cards} lang={lang} c={c} onSwipe={onSwipe} onOpen={setOpen} />
            ) : (
              <View style={ui.center}>
                <Text style={ui.big}>🎉</Text>
                <Text style={[ui.h2, { color: c.ink }]}>{t('endTitle')}</Text>
                <Text style={[ui.note, { color: c.quiet }]}>{t('endText')}</Text>
                {skipped ? <Button c={c} label={t('showSkipped')} onPress={showSkipped} /> : null}
              </View>
            )}
            {feed && cards.length && !prefs.hint ? (
              <View style={[styles.hint, { backgroundColor: c.ink }]}>
                <Text style={[styles.hintText, { color: c.bg }]}>{t('hint')}</Text>
                <Pressable onPress={() => setPref({ hint: true })} hitSlop={8}>
                  <Text style={[styles.hintOk, { color: c.accent }]}>{t('hintOk')}</Text>
                </Pressable>
              </View>
            ) : askHome && cards.length ? (
              <View style={[styles.hint, { backgroundColor: c.ink }]}>
                <Text style={[styles.hintText, { color: c.bg }]}>{t('homeText')}</Text>
                <Pressable
                  onPress={() => {
                    haptic();
                    addToHomeScreen();
                    setPref({ home: true });
                  }}
                  hitSlop={8}
                >
                  <Text style={[styles.hintOk, { color: c.accent }]}>{t('homeAdd')}</Text>
                </Pressable>
                <Pressable onPress={() => setPref({ home: true })} hitSlop={8} accessibilityLabel={t('close')}>
                  <Text style={[styles.hintOk, { color: c.quiet }]}>✕</Text>
                </Pressable>
              </View>
            ) : null}
          </View>

          {feed && cards.length ? (
            <View style={styles.actions}>
              <Round c={c} color={c.skip} label="✕" title={t('skip')} onPress={() => deck.current?.swipe('left')} />
              <Round
                c={c}
                color={c.quiet}
                label="↺"
                small
                title={t('undo')}
                disabled={!history.length}
                onPress={undo}
              />
              <Round c={c} color={c.like} label="♥" title={t('like')} onPress={() => deck.current?.swipe('right')} />
            </View>
          ) : null}
          {feed && cards.length ? (
            <Text style={[styles.left, { color: c.quiet }]}>
              {t('left')}: {cards.length}
            </Text>
          ) : null}
        </>
      ) : tab === 'profile' && showProfile ? (
        <ProfileTab
          c={c}
          lang={lang}
          index={index}
          name={account.first_name}
          city={city}
          backRef={profileBack}
          onProfile={(has) => {
            setAccount((a) => (a ? { ...a, profile: has } : a));
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
      ) : tracker !== 'off' ? (
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
        <Tab c={c} active={tab === 'feed'} icon="🃏" label={t('feed')} onPress={() => setTab('feed')} />
        {tracker !== 'off' ? (
          <Tab
            c={c}
            active={tab === 'applications' || tab === 'liked'}
            icon="📋"
            label={A[lang].tab}
            badge={trackerItems?.length}
            onPress={() => setTab('applications')}
          />
        ) : (
          <Tab c={c} active={tab === 'liked'} icon="♥" label={t('liked')} badge={liked.length} onPress={() => setTab('liked')} />
        )}
        {tracker === 'server' ? (
          <Tab
            c={c}
            active={tab === 'reminders'}
            icon="🔔"
            label={R[lang].tab}
            badge={reminders?.due}
            alert
            onPress={() => setTab('reminders')}
          />
        ) : null}
        {showProfile ? (
          <Tab c={c} active={tab === 'profile'} icon="👤" label={P[lang].tab} onPress={() => setTab('profile')} />
        ) : null}
      </View>

      <Modal visible={!!open} animationType="slide" onRequestClose={() => setOpen(null)} transparent>
        {/* У модального окна своя иерархия view: отступы под вырез экрана считаем заново */}
        <ModalArea>
          {open ? (
            <Details
              v={open}
              lang={lang}
              c={c}
              onClose={() => setOpen(null)}
              onApply={
                tracker !== 'off'
                  ? () => {
                      setOpen(null);
                      startApply(open);
                    }
                  : undefined
              }
            />
          ) : null}
        </ModalArea>
      </Modal>
      <Modal visible={!!applying} animationType="slide" onRequestClose={() => setApplying(null)} transparent>
        <ModalArea>
          {applying && tracker !== 'off' ? (
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

function Details(props: { v: Vacancy; lang: Lang; c: Colors; onClose(): void; onApply?(): void }) {
  const { v, lang, c, onClose } = props;
  const t = (key: i18n.Key) => i18n.t(lang, key);
  return (
    <View style={styles.backdrop}>
      <SafeAreaView style={[styles.sheet, { backgroundColor: c.card }]} edges={['bottom']}>
        <Pressable onPress={onClose} style={styles.close} hitSlop={12}>
          <Text style={[styles.closeText, { color: c.quiet }]}>✕</Text>
        </Pressable>
        <View style={ui.flex}>
          <VacancyCard v={v} lang={lang} c={c} full />
        </View>
        <View style={styles.sheetActions}>
          <Button c={c} label={t('apply')} onPress={props.onApply ?? (() => openUrl(v.source_url ?? v.url))} />
          <View style={ui.row}>
            <Button c={c} ghost label={`↗ ${t('share')}`} onPress={() => shareVacancy(v, lang, 'any')} />
            <Button c={c} ghost label="WhatsApp" onPress={() => shareVacancy(v, lang, 'whatsapp')} />
          </View>
          <View style={ui.row}>
            {v.map ? <Button c={c} ghost label={`🗺 ${t('onMap')}`} onPress={() => openUrl(v.map!)} /> : null}
            <Button c={c} ghost label={t('onSite')} onPress={() => openUrl(v.url)} />
          </View>
        </View>
      </SafeAreaView>
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
  if (!items.length) {
    return (
      <View style={ui.center}>
        <Text style={ui.big}>♥</Text>
        <Text style={[ui.note, { color: c.quiet }]}>{t('emptyLiked')}</Text>
      </View>
    );
  }
  return (
    <FlatList
      data={items}
      keyExtractor={(v) => v.id}
      contentContainerStyle={styles.likedList}
      renderItem={({ item: v }) => (
        <Pressable
          onPress={() => onOpen(v)}
          style={[styles.likedRow, { backgroundColor: c.card, borderColor: c.line }]}
        >
          <Text style={[styles.likedTitle, { color: c.ink }]} numberOfLines={2}>
            {i18n.title(v, lang)}
          </Text>
          <Text style={{ color: c.quiet }} numberOfLines={1}>
            {[v.employer, i18n.age(v.posted_at, lang)].filter(Boolean).join(' · ')}
          </Text>
          {i18n.pay(v, lang) ? (
            <Text style={[styles.likedPay, { color: c.accent }]}>{i18n.pay(v, lang)}</Text>
          ) : null}
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
  logo: { fontSize: 22, fontWeight: '900', letterSpacing: -0.5 },
  pickerHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  account: { fontSize: 13, paddingHorizontal: 16, marginTop: -4, marginBottom: 8 },
  cityList: { paddingHorizontal: 16, paddingBottom: 24, gap: 8 },
  cityRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
  },
  cityName: { fontSize: 17, fontWeight: '600' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  cityButton: { fontSize: 18, fontWeight: '700' },
  cats: { flexGrow: 0 },
  catsRow: { paddingHorizontal: 16, paddingVertical: 8, gap: 6 },
  deckArea: { flex: 1, marginHorizontal: 16, marginTop: 4 },
  hint: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    borderRadius: 14,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  hintText: { flex: 1, fontSize: 14, lineHeight: 19 },
  hintOk: { fontSize: 15, fontWeight: '700' },
  actions: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 24,
    paddingTop: 14,
  },
  left: { textAlign: 'center', fontSize: 12, paddingVertical: 6 },
  tabs: { flexDirection: 'row', borderTopWidth: 1 },
  likedList: { padding: 16, gap: 10 },
  likedRow: { padding: 16, borderRadius: 16, borderWidth: 1, gap: 4 },
  likedTitle: { fontSize: 17, fontWeight: '700' },
  likedPay: { fontSize: 16, fontWeight: '700', marginBottom: 6 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    height: '92%',
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: 'hidden',
  },
  close: { position: 'absolute', top: 14, right: 18, zIndex: 2 },
  closeText: { fontSize: 22 },
  sheetActions: { padding: 16, gap: 8 },
});

import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BackHandler, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { loadCity, loadIndex } from './src/api';
import * as i18n from './src/i18n';
import {
  addToHomeScreen,
  haptic,
  homeScreenStatus,
  initTelegram,
  launchBeta,
  launchCity,
  openUrl,
  shareLink,
  telegram,
  useBackButton,
  whatsapp,
  type HomeScreen,
} from './src/platform';
import { ProfileTab } from './src/profile/ProfileTab';
import { P } from './src/profile/texts';
import { setBeta, whoAmI, type Account } from './src/server';
import { read, write } from './src/storage';
import { SwipeDeck, type DeckHandle, type Dir } from './src/SwipeDeck';
import { useColors, type Colors } from './src/theme';
import type { Index, Lang, Liked, Vacancy } from './src/types';
import { Button, Chip, LangSwitch, Loading, Retry, Round, Screen, Tab, styles as ui } from './src/ui';
import { VacancyCard } from './src/VacancyCard';

// hint: подсказку про свайпы закрыли; home: про значок на экране телефона уже спросили;
// beta: открыли по тестовой ссылке ?startapp=beta, профиль можно создать до общего запуска
type Prefs = { lang?: Lang; city?: string; cat?: string | null; hint?: boolean; home?: boolean; beta?: boolean };
type TabName = 'feed' | 'liked' | 'profile';
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
      const [stored, storedLiked, app] = await Promise.all([
        read<Prefs>('prefs', {}),
        read<Liked[]>('liked', []),
        initTelegram(),
      ]);
      const tgLang = app?.initDataUnsafe?.user?.language_code === 'kk' ? 'kk' : undefined;
      // Открыли по кнопке из подборки бота: сразу город этой подборки
      const linkCity = launchCity();
      const beta = stored.beta || launchBeta();
      setBeta(beta);
      setPrefs({
        ...stored,
        lang: stored.lang ?? tgLang ?? 'ru',
        ...(linkCity ? { city: linkCity } : {}),
        ...(beta ? { beta: true } : {}),
      });
      setLiked(storedLiked);
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
  useBackButton(!!open || (picking && !!city) || tab !== 'feed', () => {
    if (open) setOpen(null);
    else if (picking && city) setPicking(false);
    else if (tab === 'profile' && profileBack.current?.()) return;
    else setTab('feed');
  });

  // Вкладка «Профиль» видна, когда сервер ответил и профили открыты (или это тестировщик)
  const showProfile = !!account && (account.open || !!prefs.beta);

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
        setLiked((list) =>
          [{ ...v, city, liked_at: new Date().toISOString() }, ...list.filter((x) => x.id !== v.id)].slice(
            0,
            MAX_LIKED,
          ),
        );
      }
    },
    [city],
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
        <Tab c={c} active={tab === 'feed'} label={`🃏 ${t('feed')}`} onPress={() => setTab('feed')} />
        <Tab
          c={c}
          active={tab === 'liked'}
          label={`♥ ${t('liked')}${liked.length ? ` · ${liked.length}` : ''}`}
          onPress={() => setTab('liked')}
        />
        {showProfile ? (
          <Tab c={c} active={tab === 'profile'} label={`👤 ${P[lang].tab}`} onPress={() => setTab('profile')} />
        ) : null}
      </View>

      <Modal visible={!!open} animationType="slide" onRequestClose={() => setOpen(null)} transparent>
        {/* У модального окна своя иерархия view: отступы под вырез экрана считаем заново */}
        <SafeAreaProvider>
          {open ? <Details v={open} lang={lang} c={c} onClose={() => setOpen(null)} /> : null}
        </SafeAreaProvider>
      </Modal>
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

function Details({ v, lang, c, onClose }: { v: Vacancy; lang: Lang; c: Colors; onClose(): void }) {
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
          <Button c={c} label={t('apply')} onPress={() => openUrl(v.source_url ?? v.url)} />
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

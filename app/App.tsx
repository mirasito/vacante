import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { loadCity, loadIndex } from './src/api';
import * as i18n from './src/i18n';
import { haptic, initTelegram, openUrl, shareLink, telegram, whatsapp } from './src/platform';
import { read, write } from './src/storage';
import { SwipeDeck, type DeckHandle, type Dir } from './src/SwipeDeck';
import { useColors, type Colors } from './src/theme';
import type { Index, Lang, Liked, Vacancy } from './src/types';
import { VacancyCard } from './src/VacancyCard';

type Prefs = { lang?: Lang; city?: string; cat?: string | null; hint?: boolean };
type Seen = Record<string, 'l' | 'r'>;

const MAX_LIKED = 300;

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
  const [tab, setTab] = useState<'feed' | 'liked'>('feed');
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState<Vacancy | null>(null);
  const [attempt, setAttempt] = useState(0);
  const deck = useRef<DeckHandle>(null);
  const seenCity = useRef<string | null>(null);

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
      setPrefs({ ...stored, lang: stored.lang ?? tgLang ?? 'ru' });
      setLiked(storedLiked);
      setBooted(true);
    })();
  }, []);

  useEffect(() => {
    setError(false);
    loadIndex().then(setIndex, () => setError(true));
  }, [attempt]);

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

  const cards = useMemo(
    () => (feed ?? []).filter((v) => !seen[v.id] && (!prefs.cat || v.category === prefs.cat)),
    [feed, seen, prefs.cat],
  );
  const skipped = useMemo(() => Object.values(seen).some((d) => d === 'l'), [seen]);

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
        <Text style={[styles.h1, { color: c.ink }]}>{t('chooseCity')}</Text>
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
              <View style={styles.center}>
                <Text style={styles.big}>🎉</Text>
                <Text style={[styles.h2, { color: c.ink }]}>{t('endTitle')}</Text>
                <Text style={[styles.note, { color: c.quiet }]}>{t('endText')}</Text>
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
        <View style={styles.flex}>
          <VacancyCard v={v} lang={lang} c={c} full />
        </View>
        <View style={styles.sheetActions}>
          <Button c={c} label={t('apply')} onPress={() => openUrl(v.source_url ?? v.url)} />
          <View style={styles.row}>
            <Button c={c} ghost label={`↗ ${t('share')}`} onPress={() => shareVacancy(v, lang, 'any')} />
            <Button c={c} ghost label="WhatsApp" onPress={() => shareVacancy(v, lang, 'whatsapp')} />
          </View>
          <View style={styles.row}>
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
      <View style={styles.center}>
        <Text style={styles.big}>♥</Text>
        <Text style={[styles.note, { color: c.quiet }]}>{t('emptyLiked')}</Text>
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
          <View style={styles.row}>
            <Button c={c} small label={t('apply')} onPress={() => openUrl(v.source_url ?? v.url)} />
            <Button c={c} small ghost label={t('share')} onPress={() => shareVacancy(v, lang, 'any')} />
            <Button c={c} small ghost label={t('remove')} onPress={() => onRemove(v.id)} />
          </View>
        </Pressable>
      )}
    />
  );
}

function Screen({ c, children }: { c: Colors; children: ReactNode }) {
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.bg }]}>
      <View style={styles.column}>{children}</View>
    </SafeAreaView>
  );
}

function Loading({ c, text }: { c: Colors; text: string }) {
  return (
    <View style={[styles.center, { backgroundColor: c.bg }]}>
      <ActivityIndicator color={c.accent} />
      {text ? <Text style={[styles.note, { color: c.quiet }]}>{text}</Text> : null}
    </View>
  );
}

function Retry({ c, lang, onRetry }: { c: Colors; lang: Lang; onRetry(): void }) {
  return (
    <View style={styles.center}>
      <Text style={[styles.note, { color: c.quiet }]}>{i18n.t(lang, 'error')}</Text>
      <Button c={c} label={i18n.t(lang, 'retry')} onPress={onRetry} />
    </View>
  );
}

function LangSwitch({ lang, c, onChange }: { lang: Lang; c: Colors; onChange(l: Lang): void }) {
  return (
    <View style={[styles.langs, { borderColor: c.line }]}>
      {(['ru', 'kk'] as const).map((l) => (
        <Pressable
          key={l}
          onPress={() => onChange(l)}
          style={[styles.lang, l === lang && { backgroundColor: c.accent }]}
        >
          <Text style={[styles.langText, { color: l === lang ? '#fff' : c.quiet }]}>
            {l === 'ru' ? 'RU' : 'KZ'}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function Chip(props: { c: Colors; active: boolean; label: string; onPress(): void }) {
  const { c, active, label, onPress } = props;
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, { backgroundColor: active ? c.accent : c.card, borderColor: active ? c.accent : c.line }]}
    >
      <Text style={[styles.chipText, { color: active ? '#fff' : c.ink }]}>{label}</Text>
    </Pressable>
  );
}

function Round(props: {
  c: Colors;
  color: string;
  label: string;
  title: string;
  small?: boolean;
  disabled?: boolean;
  onPress(): void;
}) {
  const { c, color, label, title, small, disabled, onPress } = props;
  const size = small ? 48 : 64;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={title}
      style={[
        styles.round,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: c.card, borderColor: c.line },
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.roundText, { color, fontSize: small ? 22 : 30 }]}>{label}</Text>
    </Pressable>
  );
}

function Tab({ c, active, label, onPress }: { c: Colors; active: boolean; label: string; onPress(): void }) {
  return (
    <Pressable onPress={onPress} style={styles.tab}>
      <Text style={[styles.tabText, { color: active ? c.accent : c.quiet }]}>{label}</Text>
    </Pressable>
  );
}

function Button(props: { c: Colors; label: string; ghost?: boolean; small?: boolean; onPress(): void }) {
  const { c, label, ghost, small, onPress } = props;
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.button,
        small && styles.buttonSmall,
        ghost ? { borderColor: c.line, borderWidth: 1 } : { backgroundColor: c.accent },
      ]}
    >
      <Text style={[styles.buttonText, small && styles.buttonTextSmall, { color: ghost ? c.ink : '#fff' }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  column: { flex: 1, width: '100%', maxWidth: 520, alignSelf: 'center' },
  flex: { flex: 1 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  big: { fontSize: 48 },
  h1: { fontSize: 28, fontWeight: '800', paddingHorizontal: 16, marginBottom: 12 },
  h2: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  note: { fontSize: 15, textAlign: 'center', lineHeight: 21 },
  logo: { fontSize: 22, fontWeight: '900', letterSpacing: -0.5 },
  pickerHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
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
  langs: { flexDirection: 'row', borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
  lang: { paddingHorizontal: 10, paddingVertical: 5 },
  langText: { fontSize: 13, fontWeight: '700' },
  cats: { flexGrow: 0 },
  catsRow: { paddingHorizontal: 16, paddingVertical: 8, gap: 6 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: 1 },
  chipText: { fontSize: 14, fontWeight: '600' },
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
  round: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  roundText: { fontWeight: '700' },
  disabled: { opacity: 0.35 },
  left: { textAlign: 'center', fontSize: 12, paddingVertical: 6 },
  tabs: { flexDirection: 'row', borderTopWidth: 1 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 14 },
  tabText: { fontSize: 15, fontWeight: '700' },
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
  button: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
  },
  buttonSmall: { flexGrow: 0, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10 },
  buttonText: { fontSize: 16, fontWeight: '700' },
  buttonTextSmall: { fontSize: 14 },
});

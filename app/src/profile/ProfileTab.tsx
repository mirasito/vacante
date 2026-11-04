// Вкладка «Профиль»: профиль так, как его видит работодатель, сила профиля, фото, дом, ссылка,
// «Кто смотрел профиль», база кандидатов и удаление. Без профиля — приглашение его создать.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Point } from '../geo';
import * as i18n from '../i18n';
import {
  canRequestContact,
  confirm,
  copyText,
  haptic,
  onAppVisible,
  requestContact,
  requestWriteAccess,
  shareLink,
  whatsapp,
} from '../platform';
import { RemindersSection } from '../reminders/RemindersSection';
import {
  askPhone,
  cancelPhone,
  deleteMe,
  dropLink,
  getProfile,
  getViews,
  newLink,
  patchMe,
  saveProfile,
  type Language,
  type Profile,
  type ProfileView,
  type ProfileViewEvent,
  type Reminders,
  type Tip,
} from '../server';
import type { Colors } from '../theme';
import type { Index, Lang } from '../types';
import { Bar, Button, Check, Chip, Field, Loading, Retry, styles as ui } from '../ui';
import { HomeStep, type HomeDraft } from './Home';
import { Avatar, PhotoSection, usePhotoUpload, usePhotoUrl } from './Photo';
import { EMPLOYMENT, EXPERIENCE, label, LANGUAGES, money, P, phoneLabel, START, when } from './texts';
import { useVideoRecording, VideoSection } from './Video';
import { Wizard } from './Wizard';

type Mode = 'card' | 'wizard' | 'extras' | 'home';
type RemindersProps = { data: Reminders | null; onChange(next: Reminders): void; onOpenAll(): void };

export function ProfileTab(props: {
  c: Colors;
  lang: Lang;
  index: Index | null;
  name: string;
  city?: string;
  backRef: { current: (() => boolean) | null };
  /** Профиль создан или удалён: отклики переезжают на сервер или остаются на телефоне. */
  onProfile?(has: boolean): void;
  /** Дом из профиля, как только он известен и после каждой правки: лента считает по нему расстояния. */
  onHome?(home: Point | null): void;
  /** С какого экрана открыть: 'home' — сразу «Где вы живёте?» (кнопка «Рядом с домом» в ленте). */
  start?: 'home';
  /** Ближайшие напоминания и их настройки (есть, когда профиль на сервере). */
  reminders?: RemindersProps;
}) {
  const { c, lang, index, backRef } = props;
  const t = P[lang];
  const [view, setView] = useState<ProfileView | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<Mode>(props.start ?? 'card');
  const [attempt, setAttempt] = useState(0);

  // Сообщаем ленте дом из профиля: при открытии вкладки и после каждой правки
  const onHome = useRef(props.onHome);
  onHome.current = props.onHome;
  const homeLat = view?.profile?.home?.lat;
  const homeLon = view?.profile?.home?.lon;
  const loaded = view !== undefined;
  useEffect(() => {
    if (!loaded) return;
    onHome.current?.(homeLat !== undefined && homeLon !== undefined ? { lat: homeLat, lon: homeLon } : null);
  }, [loaded, homeLat, homeLon]);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    getProfile().then(
      (v) => alive && setView(v),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [attempt]);

  // Бот пишет человеку на языке приложения: сменил язык, сообщаем серверу
  const seekerLang = view?.seeker.lang;
  useEffect(() => {
    if (!seekerLang || seekerLang === lang) return;
    let alive = true;
    patchMe({ lang }).then(
      (v) => alive && setView(v),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [lang, seekerLang]);

  // Вернулись из чата бота: там могли записать или убрать кружок, прислать номер
  useEffect(
    () =>
      onAppVisible(() => {
        getProfile().then(setView, () => undefined);
      }),
    [],
  );

  if (mode !== 'wizard') backRef.current = mode === 'extras' || mode === 'home' ? () => (setMode('card'), true) : null;

  if (failed) return <Retry c={c} lang={lang} text={t.notAvailable} onRetry={() => setAttempt((n) => n + 1)} />;
  if (view === undefined) return <Loading c={c} text="" />;

  if (mode === 'wizard' || (!view && mode === 'extras')) {
    return (
      <Wizard
        c={c}
        lang={lang}
        index={index}
        name={props.name}
        city={props.city}
        existing={view?.profile ?? null}
        backRef={backRef}
        onCancel={() => setMode('card')}
        onDone={(v, created) => {
          setView(v);
          if (created) props.onProfile?.(true);
          setMode(created ? 'extras' : 'card');
        }}
      />
    );
  }
  if (!view?.profile) return <Intro c={c} lang={lang} onStart={() => setMode('wizard')} />;
  if (mode === 'extras') {
    return <Extras c={c} lang={lang} view={view} onSaved={(v) => (setView(v), setMode('card'))} onChange={setView} />;
  }
  if (mode === 'home') {
    return <HomeEdit c={c} lang={lang} view={view} onSaved={(v) => (setView(v), setMode('card'))} />;
  }
  return (
    <Card
      c={c}
      lang={lang}
      index={index}
      view={view}
      onChange={setView}
      onEdit={() => setMode('wizard')}
      onExtras={() => setMode('extras')}
      onHome={() => setMode('home')}
      onDeleted={() => {
        setView(null);
        props.onProfile?.(false);
      }}
      reminders={props.reminders}
    />
  );
}

function Intro({ c, lang, onStart }: { c: Colors; lang: Lang; onStart(): void }) {
  const t = P[lang];
  return (
    <View style={ui.center}>
      <Text style={ui.big}>🙋</Text>
      <Text style={[ui.h2, { color: c.ink }]}>{t.introTitle}</Text>
      <Text style={[ui.note, { color: c.quiet }]}>{t.introText}</Text>
      <Text style={[s.points, { color: c.ink }]}>{t.introPoints}</Text>
      <View style={s.wide}>
        <Button c={c} label={t.create} onPress={onStart} />
      </View>
    </View>
  );
}

/** Номер из Telegram приходит на сервер через бота: ждём его несколько секунд. */
async function waitForPhone(): Promise<ProfileView | null> {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const v = await getProfile().catch(() => null);
    if (v?.profile?.phone) return v;
  }
  return null;
}

/**
 * Номер окном Telegram «Поделиться номером». Telegram присылает его боту сообщением, бот передаёт
 * серверу, а сервер кладёт в профиль, потому что приложение заранее предупредило (askPhone):
 * иначе тот же контакт ушёл бы в отклик, который человек мог начать в боте.
 * Профиль с номером или null, если не вышло (тогда номер можно ввести вручную).
 */
async function phoneFromTelegram(): Promise<ProfileView | null> {
  if (!canRequestContact()) return null;
  try {
    await askPhone();
  } catch {
    return null;
  }
  if (!(await requestContact())) {
    cancelPhone().catch(() => undefined);
    return null;
  }
  return waitForPhone();
}

/** «Где вы живёте?» из профиля: тот же экран, что в анкете, и «Сохранить». */
function HomeEdit({ c, lang, view, onSaved }: { c: Colors; lang: Lang; view: ProfileView; onSaved(v: ProfileView): void }) {
  const t = P[lang];
  const profile = view.profile!;
  const [place, setPlace] = useState<HomeDraft>({ home: profile.home, label: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      onSaved(await saveProfile({ ...profile, home: place.home }, lang));
    } catch {
      setError(t.saveError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={ui.flex}>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <HomeStep c={c} lang={lang} value={place} onChange={setPlace} />
        {error ? <Text style={[s.error, { color: c.skip }]}>{error}</Text> : null}
      </ScrollView>
      <View style={s.foot}>
        <Button c={c} label={t.save} busy={busy} onPress={save} />
      </View>
    </View>
  );
}

function Extras(props: { c: Colors; lang: Lang; view: ProfileView; onSaved(v: ProfileView): void; onChange(v: ProfileView): void }) {
  const { c, lang, view, onSaved, onChange } = props;
  const t = P[lang];
  const profile = view.profile!;
  const [phone, setPhone] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [languages, setLanguages] = useState<Language[]>(profile.languages);
  const [about, setAbout] = useState(profile.about ?? '');
  const [medBook, setMedBook] = useState(profile.med_book);
  const [driver, setDriver] = useState(profile.driver);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const rec = useVideoRecording(view, onChange);
  const photo = usePhotoUpload(lang, onChange);

  const fromTelegram = async () => {
    haptic();
    setWaiting(true);
    const v = await phoneFromTelegram();
    setWaiting(false);
    if (v) onChange(v);
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const next: Profile = {
        ...profile,
        phone: phone.trim() || profile.phone,
        languages,
        about: about.trim() || null,
        med_book: medBook,
        driver,
      };
      onSaved(await saveProfile(next, lang));
    } catch (err) {
      setError(err instanceof Error && err.message.startsWith('Телефон') ? err.message : t.saveError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={ui.flex}>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <Text style={[s.title, { color: c.ink }]}>{t.readyTitle}</Text>
        <Strength c={c} lang={lang} view={view} />
        <Text style={[s.text, { color: c.quiet }]}>{t.readyText}</Text>
        <PhotoSection c={c} lang={lang} view={view} photo={photo} />
        <VideoSection c={c} lang={lang} view={view} rec={rec} onChange={onChange} />

        <Text style={[s.section, { color: c.ink }]}>{t.phone}</Text>
        {profile.phone ? (
          <Text style={[s.value, { color: c.ink }]}>✓ {phoneLabel(profile.phone)}</Text>
        ) : (
          <>
            {canRequestContact() ? (
              <Button c={c} ghost label={waiting ? t.phoneWaiting : t.phoneFromTg} busy={waiting} onPress={fromTelegram} />
            ) : null}
            <Field
              c={c}
              placeholder={t.phoneManual}
              keyboardType="phone-pad"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChangeText={setPhone}
              maxLength={20}
            />
          </>
        )}

        <Text style={[s.section, { color: c.ink }]}>{t.languages}</Text>
        <View style={ui.row}>
          {LANGUAGES.map((l) => (
            <Chip
              key={l.value}
              c={c}
              active={languages.includes(l.value)}
              label={l.label}
              onPress={() =>
                setLanguages((list) => (list.includes(l.value) ? list.filter((x) => x !== l.value) : [...list, l.value]))
              }
            />
          ))}
        </View>

        <Field
          c={c}
          label={t.about}
          placeholder={t.aboutHint}
          value={about}
          onChangeText={setAbout}
          multiline
          numberOfLines={3}
          maxLength={300}
          style={s.area}
        />

        <Text style={[s.section, { color: c.ink }]}>{t.documents}</Text>
        <Check c={c} checked={medBook} label={t.medBook} onPress={() => setMedBook(!medBook)} />
        <Check c={c} checked={driver} label={t.driver} onPress={() => setDriver(!driver)} />
        {error ? <Text style={[s.error, { color: c.skip }]}>{error}</Text> : null}
      </ScrollView>
      <View style={s.foot}>
        <Button c={c} label={t.save} busy={busy} onPress={save} />
      </View>
    </View>
  );
}

function Strength({ c, lang, view, onTip }: { c: Colors; lang: Lang; view: ProfileView; onTip?(tip: Tip): void }) {
  const t = P[lang];
  const { next, percent } = view.strength!;
  return (
    <View style={s.strength}>
      <View style={s.strengthHead}>
        <Text style={[s.strengthText, { color: c.ink }]}>{t.strength(percent)}</Text>
        {next && onTip ? (
          <Pressable onPress={() => onTip(next)} hitSlop={8}>
            <Text style={[s.tip, { color: c.accent }]}>{t.tips[next]}</Text>
          </Pressable>
        ) : next ? (
          <Text style={[s.tip, { color: c.quiet }]}>{t.tips[next]}</Text>
        ) : null}
      </View>
      <Bar c={c} value={percent} />
    </View>
  );
}

function Card(props: {
  c: Colors;
  lang: Lang;
  index: Index | null;
  view: ProfileView;
  onChange(v: ProfileView): void;
  onEdit(): void;
  onExtras(): void;
  onHome(): void;
  onDeleted(): void;
  reminders?: RemindersProps;
}) {
  const { c, lang, index, view, onChange, onEdit, onExtras, onHome, onDeleted, reminders } = props;
  const t = P[lang];
  const p = view.profile!;
  const [views, setViews] = useState<ProfileViewEvent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const rec = useVideoRecording(view, onChange);
  const photo = usePhotoUpload(lang, onChange);
  const photoUrl = usePhotoUrl(view);

  const loadViews = useCallback(() => {
    getViews().then(setViews, () => setViews([]));
  }, []);
  useEffect(loadViews, [loadViews]);

  const roleName = (title: string) => (lang === 'kk' ? index?.roles?.find((r) => r.title === title)?.title_kk ?? title : title);
  const city = index?.cities.find((ct) => ct.slug === p.city);
  const place = [city ? i18n.cityName(city, lang) : p.city, p.district].filter(Boolean).join(', ');
  const pay = p.pay_from ? t.payFrom(money(p.pay_from), p.pay_period === 'shift' ? t.perShift : t.perMonth) : null;
  const docs = [p.med_book ? t.medBook : null, p.driver ? t.driver : null].filter(Boolean).join(', ');

  const share = async (via: 'telegram' | 'whatsapp' | 'copy') => {
    haptic();
    setBusy(true);
    setNotice('');
    try {
      let link = view.link;
      if (!link) {
        link = await newLink();
        onChange({ ...view, link });
      }
      // Буфер обмена открыт только сразу после нажатия: если ссылку пришлось сначала выпустить,
      // копирование может не пройти, тогда второе нажатие скопирует уже готовую ссылку
      if (via === 'copy') setNotice(copyText(link.url) ? t.linkCopied : t.copyAgain);
      else if (via === 'whatsapp') whatsapp(t.shareText, link.url);
      else await shareLink(t.shareText, link.url);
    } finally {
      setBusy(false);
    }
  };

  const linkOff = async () => {
    if (!(await confirm(t.linkOffAsk, t.yes, t.no))) return;
    await dropLink().catch(() => undefined);
    onChange({ ...view, link: null });
  };

  const toggleBase = async () => {
    haptic();
    onChange(await patchMe({ base: !view.seeker.base }).catch(() => view));
  };

  const remove = async () => {
    if (!(await confirm(t.removeAsk, t.yes, t.no))) return;
    setBusy(true);
    try {
      await deleteMe();
      onDeleted();
    } finally {
      setBusy(false);
    }
  };

  const onTip = async (tip: Tip) => {
    if (tip === 'video') return rec.start();
    // Окно выбора фото открывается только прямо из нажатия, поэтому до любых await
    if (tip === 'photo') return photo.upload();
    const v = tip === 'phone' ? await phoneFromTelegram() : null;
    if (v) onChange(v);
    else onExtras();
  };

  return (
    <ScrollView contentContainerStyle={s.body}>
      <Strength c={c} lang={lang} view={view} onTip={onTip} />
      <VideoSection c={c} lang={lang} view={view} rec={rec} onChange={onChange} />

      <Text style={[s.caption, { color: c.quiet }]}>{t.asEmployer}</Text>
      <View style={[s.card, { backgroundColor: c.card, borderColor: c.line }]}>
        <View style={s.who}>
          <Avatar c={c} name={p.name} url={photoUrl} size={64} />
          <View style={ui.flex}>
            <Text style={[s.name, { color: c.ink }]}>{p.name}</Text>
            <Text style={{ color: c.quiet }}>{place}</Text>
          </View>
        </View>
        <View style={ui.row}>
          {p.roles.map((r) => (
            <Text key={r} style={[s.pill, { backgroundColor: c.pill, color: c.ink }]}>
              {roleName(r)}
            </Text>
          ))}
        </View>
        <Fact c={c} k={t.experience} v={label(EXPERIENCE, p.experience, lang)} />
        <Fact c={c} k={t.employment} v={p.employment.map((e) => label(EMPLOYMENT, e, lang)).join(', ')} />
        {pay ? <Fact c={c} k={t.pay} v={pay} /> : null}
        <Fact c={c} k={t.start} v={label(START, p.start, lang)} />
        {p.languages.length ? (
          <Fact c={c} k={t.languages} v={p.languages.map((l) => LANGUAGES.find((x) => x.value === l)?.label).join(', ')} />
        ) : null}
        {docs ? <Fact c={c} k={t.documents} v={docs} /> : null}
        {p.about ? <Fact c={c} k={t.about} v={p.about} /> : null}
        {p.phone ? <Fact c={c} k={t.phone} v={phoneLabel(p.phone)} hint={t.phoneHidden} /> : null}
      </View>

      {photo.busy || photo.error ? (
        <Text style={[s.small, { color: photo.error ? c.skip : c.quiet }]}>{photo.error || t.photoUploading}</Text>
      ) : null}
      <Pressable onPress={onHome} hitSlop={8} style={s.homeRow}>
        <Text style={[s.small, ui.flex, { color: p.home ? c.quiet : c.ink }]}>{p.home ? t.homeCard : t.homeAsk}</Text>
        <Text style={[s.small, { color: c.accent, fontWeight: '600' }]}>{t.homeChange}</Text>
      </Pressable>

      <Button c={c} ghost label={t.edit} onPress={onEdit} />
      <Button c={c} ghost label={t.more} onPress={onExtras} />

      <Text style={[s.section, { color: c.ink }]}>{t.shareTitle}</Text>
      <View style={ui.row}>
        <Button c={c} label="Telegram" busy={busy} onPress={() => share('telegram')} />
        <Button c={c} ghost label="WhatsApp" disabled={busy} onPress={() => share('whatsapp')} />
        <Button c={c} ghost label={t.copyLink} disabled={busy} onPress={() => share('copy')} />
      </View>
      {notice ? <Text style={[s.small, { color: c.quiet }]}>{notice}</Text> : null}
      {view.link ? (
        <View style={s.linkRow}>
          <Text style={[s.small, ui.flex, { color: c.quiet }]} numberOfLines={2}>
            ✓ {t.linkActive}: {view.link.url.replace('https://', '')}
          </Text>
          <Pressable onPress={linkOff} hitSlop={8}>
            <Text style={[s.small, { color: c.skip }]}>{t.linkOff}</Text>
          </Pressable>
        </View>
      ) : null}

      <Check c={c} checked={view.seeker.base} label={t.baseTitle} hint={t.baseHint} onPress={toggleBase} />

      {reminders ? (
        <RemindersSection
          c={c}
          lang={lang}
          data={reminders.data}
          writeAccess={view.seeker.write_access}
          onChange={reminders.onChange}
          onOpenAll={reminders.onOpenAll}
          onAllowBot={async () => {
            if (await requestWriteAccess()) onChange(await patchMe({ write_access: true }).catch(() => view));
          }}
        />
      ) : null}

      <Text style={[s.section, { color: c.ink }]}>👀 {t.viewsTitle}</Text>
      {views === null ? null : views.length ? (
        views.map((v, i) => (
          <Text key={`${v.at}-${i}`} style={[s.small, { color: c.ink }]}>
            {when(v.at, lang)} · {v.viewer ?? (v.via === 'application' ? t.viewByApplication : t.viewByLink)}
            {v.phone_shown ? ` · ${t.viewPhone}` : ''}
          </Text>
        ))
      ) : (
        <Text style={[s.small, { color: c.quiet }]}>{t.viewsEmpty}</Text>
      )}

      <View style={s.danger}>
        <Button c={c} danger label={t.remove} disabled={busy} onPress={remove} />
      </View>
    </ScrollView>
  );
}

function Fact({ c, k, v, hint }: { c: Colors; k: string; v: string; hint?: string }) {
  return (
    <View>
      <Text style={[s.factKey, { color: c.quiet }]}>{k}</Text>
      <Text style={[s.factValue, { color: c.ink }]}>{v}</Text>
      {hint ? <Text style={[s.factKey, { color: c.quiet }]}>{hint}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  body: { padding: 16, gap: 12, paddingBottom: 32 },
  wide: { alignSelf: 'stretch', marginTop: 8 },
  points: { fontSize: 15, lineHeight: 24, alignSelf: 'stretch', paddingHorizontal: 8 },
  title: { fontSize: 26, fontWeight: '800' },
  text: { fontSize: 15, lineHeight: 21 },
  section: { fontSize: 17, fontWeight: '700', marginTop: 8 },
  value: { fontSize: 16, fontWeight: '600' },
  area: { minHeight: 80, textAlignVertical: 'top' },
  error: { fontSize: 15, textAlign: 'center' },
  foot: { padding: 16, paddingTop: 8 },
  strength: { gap: 8 },
  strengthHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  strengthText: { fontSize: 18, fontWeight: '800' },
  tip: { fontSize: 14, fontWeight: '600' },
  caption: { fontSize: 13, marginTop: 4 },
  card: { borderWidth: 1, borderRadius: 18, padding: 16, gap: 10 },
  who: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  homeRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  name: { fontSize: 22, fontWeight: '800' },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, overflow: 'hidden', fontWeight: '600' },
  factKey: { fontSize: 12 },
  factValue: { fontSize: 15, fontWeight: '600' },
  linkRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' },
  small: { fontSize: 14, lineHeight: 20 },
  danger: { marginTop: 16 },
});

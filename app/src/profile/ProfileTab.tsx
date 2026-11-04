// Вкладка «Профиль»: профиль так, как его видит работодатель, сила профиля, ссылка,
// «Кто смотрел профиль», база кандидатов и удаление. Без профиля — приглашение его создать.
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as i18n from '../i18n';
import { canRequestContact, confirm, haptic, onAppVisible, requestContact, shareLink, whatsapp } from '../platform';
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
  type Tip,
} from '../server';
import type { Colors } from '../theme';
import type { Index, Lang } from '../types';
import { Bar, Button, Check, Chip, Field, Loading, Retry, styles as ui } from '../ui';
import { EMPLOYMENT, EXPERIENCE, label, LANGUAGES, money, P, phoneLabel, START, when } from './texts';
import { useVideoRecording, VideoSection } from './Video';
import { Wizard } from './Wizard';

type Mode = 'card' | 'wizard' | 'extras';

export function ProfileTab(props: {
  c: Colors;
  lang: Lang;
  index: Index | null;
  name: string;
  city?: string;
  backRef: { current: (() => boolean) | null };
}) {
  const { c, lang, index, backRef } = props;
  const t = P[lang];
  const [view, setView] = useState<ProfileView | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<Mode>('card');
  const [attempt, setAttempt] = useState(0);

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

  if (mode !== 'wizard') backRef.current = mode === 'extras' ? () => (setMode('card'), true) : null;

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
          setMode(created ? 'extras' : 'card');
        }}
      />
    );
  }
  if (!view?.profile) return <Intro c={c} lang={lang} onStart={() => setMode('wizard')} />;
  if (mode === 'extras') {
    return <Extras c={c} lang={lang} view={view} onSaved={(v) => (setView(v), setMode('card'))} onChange={setView} />;
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
      onDeleted={() => setView(null)}
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
  onDeleted(): void;
}) {
  const { c, lang, index, view, onChange, onEdit, onExtras, onDeleted } = props;
  const t = P[lang];
  const p = view.profile!;
  const [views, setViews] = useState<ProfileViewEvent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const rec = useVideoRecording(view, onChange);

  const loadViews = useCallback(() => {
    getViews().then(setViews, () => setViews([]));
  }, []);
  useEffect(loadViews, [loadViews]);

  const roleName = (title: string) => (lang === 'kk' ? index?.roles?.find((r) => r.title === title)?.title_kk ?? title : title);
  const city = index?.cities.find((ct) => ct.slug === p.city);
  const place = [city ? i18n.cityName(city, lang) : p.city, p.district].filter(Boolean).join(', ');
  const pay = p.pay_from ? t.payFrom(money(p.pay_from), p.pay_period === 'shift' ? t.perShift : t.perMonth) : null;
  const docs = [p.med_book ? t.medBook : null, p.driver ? t.driver : null].filter(Boolean).join(', ');

  const share = async (via: 'telegram' | 'whatsapp') => {
    haptic();
    setBusy(true);
    try {
      let link = view.link;
      if (!link) {
        link = await newLink();
        onChange({ ...view, link });
      }
      if (via === 'whatsapp') whatsapp(t.shareText, link.url);
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
          <View style={[s.avatar, { backgroundColor: c.pill }]}>
            <Text style={[s.initials, { color: c.accent }]}>{initials(p.name)}</Text>
          </View>
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

      <Button c={c} ghost label={t.edit} onPress={onEdit} />
      <Button c={c} ghost label={t.more} onPress={onExtras} />

      <Text style={[s.section, { color: c.ink }]}>{t.shareTitle}</Text>
      <View style={ui.row}>
        <Button c={c} label="Telegram" busy={busy} onPress={() => share('telegram')} />
        <Button c={c} ghost label="WhatsApp" disabled={busy} onPress={() => share('whatsapp')} />
      </View>
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

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');

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
  avatar: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  initials: { fontSize: 24, fontWeight: '800' },
  name: { fontSize: 22, fontWeight: '800' },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, overflow: 'hidden', fontWeight: '600' },
  factKey: { fontSize: 12 },
  factValue: { fontSize: 15, fontWeight: '600' },
  linkRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' },
  small: { fontSize: 14, lineHeight: 20 },
  danger: { marginTop: 16 },
});

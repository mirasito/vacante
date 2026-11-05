// Создание и правка профиля: согласие и семь экранов с кнопками.
// Экраны с одним ответом переходят дальше сами, чтобы анкета занимала пару минут.
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as i18n from '../i18n';
import { haptic, requestWriteAccess } from '../platform';
import {
  ApiError,
  patchMe,
  saveProfile,
  type Employment,
  type Experience,
  type PayPeriod,
  type Profile,
  type ProfileView,
  type Start,
} from '../server';
import type { Want } from '../feed';
import type { Colors } from '../theme';
import type { Index, Lang } from '../types';
import { Bar, Button, Check, Chip, Field, styles as ui } from '../ui';
import { HomeStep, type HomeDraft } from './Home';
import { CONSENT, EMPLOYMENT, EXPERIENCE, money, P, PAY_PERIOD, PAY_PRESETS, START } from './texts';

type Step = 'consent' | 'place' | 'home' | 'roles' | 'experience' | 'employment' | 'pay' | 'start';
const STEPS: Step[] = ['place', 'home', 'roles', 'experience', 'employment', 'pay', 'start'];
const MAX_ROLES = 3;

interface Draft {
  name: string;
  city: string;
  place: HomeDraft;
  roles: string[];
  experience: Experience | null;
  employment: Employment[];
  pay: string;
  pay_period: PayPeriod;
  start: Start | null;
}

function draftOf(existing: Profile | null, name: string, city: string | undefined, seed?: Want): Draft {
  return {
    name: existing?.name ?? name,
    city: existing?.city ?? city ?? '',
    place: { home: existing?.home ?? null, label: '' },
    // Без профиля подставляем ответы со старта («Кем работаешь», «Где и когда»)
    roles: existing?.roles ?? seed?.roles ?? [],
    experience: existing?.experience ?? seed?.experience ?? null,
    employment: existing?.employment ?? seed?.employment ?? [],
    pay: existing?.pay_from ? String(existing.pay_from) : '',
    pay_period: existing?.pay_period ?? 'month',
    start: existing?.start ?? null,
  };
}

export function Wizard(props: {
  c: Colors;
  lang: Lang;
  index: Index | null;
  name: string;
  city?: string;
  /** Правка существующего профиля: без согласия, поля по желанию сохраняются как были. */
  existing: Profile | null;
  /** Ответы стартовых экранов: подсказка для новой анкеты. */
  seed?: Want;
  onDone(view: ProfileView, created: boolean): void;
  onCancel(): void;
  /** Кнопка «Назад» Telegram и Android: шаг назад; false, если шагать некуда. */
  backRef: { current: (() => boolean) | null };
}) {
  const { c, lang, index, existing, onDone, onCancel, backRef } = props;
  const t = P[lang];
  const [step, setStep] = useState<Step>(existing ? 'place' : 'consent');
  const [draft, setDraft] = useState<Draft>(() => draftOf(existing, props.name, props.city, props.seed));
  const [adult, setAdult] = useState(false);
  const [agree, setAgree] = useState(false);
  const [base, setBase] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const order: Step[] = existing ? STEPS : ['consent', ...STEPS];
  const at = order.indexOf(step);

  const back = () => {
    setError('');
    if (at <= 0) {
      onCancel();
      return false;
    }
    setStep(order[at - 1]!);
    return true;
  };
  backRef.current = () => {
    back();
    return true;
  };
  const next = () => {
    haptic();
    setError('');
    setStep(order[at + 1]!);
  };

  async function submit(final: Draft) {
    if (busy) return;
    setBusy(true);
    setError('');
    const pay = Number(final.pay.replace(/\D/g, ''));
    const profile: Profile = {
      name: final.name.trim(),
      city: final.city,
      // Вместо района теперь дом: прежний район уходит из анкеты при первой правке
      district: null,
      home: final.place.home,
      roles: final.roles,
      experience: final.experience!,
      employment: final.employment,
      pay_from: pay > 0 ? pay : null,
      pay_period: pay > 0 ? final.pay_period : null,
      start: final.start!,
      phone: existing?.phone ?? null,
      languages: existing?.languages ?? [],
      about: existing?.about ?? null,
      med_book: existing?.med_book ?? false,
      driver: existing?.driver ?? false,
    };
    try {
      let view = await saveProfile(profile, lang, existing ? undefined : { adult, base });
      if (!existing) {
        // Без разрешения бот не сможет присылать напоминания: окно Telegram, нажать один раз
        const allowed = await requestWriteAccess();
        if (allowed) view = await patchMe({ write_access: true }).catch(() => view);
      }
      haptic('medium');
      onDone(view, !existing);
    } catch (err) {
      setError(err instanceof ApiError && err.status >= 400 && err.status < 500 ? err.message : t.saveError);
    } finally {
      setBusy(false);
    }
  }

  const stepNumber = STEPS.indexOf(step) + 1;
  return (
    <View style={ui.flex}>
      <View style={s.head}>
        <Pressable onPress={back} hitSlop={12} accessibilityLabel={t.back}>
          <Text style={[s.backText, { color: c.accent }]}>← {t.back}</Text>
        </Pressable>
        {stepNumber > 0 ? <Text style={{ color: c.quiet }}>{t.step(stepNumber, STEPS.length)}</Text> : null}
      </View>
      {stepNumber > 0 ? (
        <View style={s.progress}>
          <Bar c={c} value={(stepNumber / STEPS.length) * 100} />
        </View>
      ) : null}
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        {step === 'consent' ? (
          <Consent c={c} lang={lang} adult={adult} agree={agree} base={base} onAdult={setAdult} onAgree={setAgree} onBase={setBase} />
        ) : step === 'place' ? (
          <Place c={c} lang={lang} index={index} draft={draft} set={set} />
        ) : step === 'home' ? (
          <HomeStep c={c} lang={lang} value={draft.place} onChange={(place) => set({ place })} />
        ) : step === 'roles' ? (
          <Roles c={c} lang={lang} index={index} draft={draft} set={set} />
        ) : step === 'experience' ? (
          <OneOf
            c={c}
            lang={lang}
            title={t.experienceTitle}
            items={EXPERIENCE}
            value={draft.experience}
            onPick={(experience) => {
              set({ experience });
              next();
            }}
          />
        ) : step === 'employment' ? (
          <>
            <Text style={[s.title, { color: c.ink }]}>{t.employmentTitle}</Text>
            <Text style={[s.hint, { color: c.quiet }]}>{t.employmentHint}</Text>
            <View style={s.options}>
              {EMPLOYMENT.map((e) => (
                <Chip
                  key={e.value}
                  c={c}
                  big
                  active={draft.employment.includes(e.value)}
                  label={e[lang]}
                  onPress={() =>
                    set({
                      employment: draft.employment.includes(e.value)
                        ? draft.employment.filter((x) => x !== e.value)
                        : [...draft.employment, e.value],
                    })
                  }
                />
              ))}
            </View>
          </>
        ) : step === 'pay' ? (
          <Pay c={c} lang={lang} draft={draft} set={set} />
        ) : (
          <OneOf
            c={c}
            lang={lang}
            title={t.startTitle}
            items={START}
            value={draft.start}
            onPick={(start) => {
              const final = { ...draft, start };
              set({ start });
              submit(final);
            }}
          />
        )}
        {error ? <Text style={[s.error, { color: c.skip }]}>{error}</Text> : null}
      </ScrollView>
      {step === 'experience' || step === 'start' ? (
        busy ? (
          <View style={s.foot}>
            <Button c={c} label={t.save} busy onPress={() => undefined} />
          </View>
        ) : step === 'start' && draft.start && error ? (
          <View style={s.foot}>
            <Button c={c} label={t.save} onPress={() => submit(draft)} />
          </View>
        ) : null
      ) : (
        <View style={s.foot}>
          <Button
            c={c}
            label={
              step === 'consent'
                ? t.create
                : step === 'pay' && !draft.pay
                  ? t.payAny
                  : step === 'home' && !draft.place.home
                    ? t.skip
                    : t.next
            }
            disabled={!ready(step, draft, adult && agree)}
            onPress={next}
          />
        </View>
      )}
    </View>
  );
}

function ready(step: Step, d: Draft, consented: boolean): boolean {
  switch (step) {
    case 'consent':
      return consented;
    case 'place':
      return !!d.name.trim() && !!d.city;
    case 'roles':
      return d.roles.length > 0;
    case 'employment':
      return d.employment.length > 0;
    default:
      return true;
  }
}

function Consent(props: {
  c: Colors;
  lang: Lang;
  adult: boolean;
  agree: boolean;
  base: boolean;
  onAdult(v: boolean): void;
  onAgree(v: boolean): void;
  onBase(v: boolean): void;
}) {
  const { c, lang } = props;
  const t = P[lang];
  const consent = CONSENT[lang];
  return (
    <>
      <Text style={[s.title, { color: c.ink }]}>{consent.title}</Text>
      <View style={[s.card, { backgroundColor: c.card, borderColor: c.line }]}>
        {consent.points.map(([head, text]) => (
          <View key={head} style={s.point}>
            <Text style={[s.pointHead, { color: c.ink }]}>{head}</Text>
            <Text style={[s.pointText, { color: c.quiet }]}>{text}</Text>
          </View>
        ))}
      </View>
      <View style={s.checks}>
        <Check c={c} checked={props.adult} label={t.adult} onPress={() => props.onAdult(!props.adult)} />
        <Check c={c} checked={props.agree} label={t.agree} onPress={() => props.onAgree(!props.agree)} />
        <Check c={c} checked={props.base} label={t.base} hint={t.baseHint} onPress={() => props.onBase(!props.base)} />
      </View>
    </>
  );
}

function Place({ c, lang, index, draft, set }: { c: Colors; lang: Lang; index: Index | null; draft: Draft; set(p: Partial<Draft>): void }) {
  const t = P[lang];
  return (
    <>
      <Text style={[s.title, { color: c.ink }]}>{t.placeTitle}</Text>
      <Field c={c} label={t.name} value={draft.name} onChangeText={(name) => set({ name })} maxLength={40} autoComplete="given-name" />
      <View style={s.options}>
        {(index?.cities ?? []).map((ct) => (
          <Chip key={ct.slug} c={c} active={draft.city === ct.slug} label={i18n.cityName(ct, lang)} onPress={() => set({ city: ct.slug })} />
        ))}
      </View>
    </>
  );
}

function Roles({ c, lang, index, draft, set }: { c: Colors; lang: Lang; index: Index | null; draft: Draft; set(p: Partial<Draft>): void }) {
  const t = P[lang];
  const [query, setQuery] = useState('');
  const [full, setFull] = useState(false);
  const all = index?.roles ?? [];
  const name = (title: string) => (lang === 'kk' ? all.find((r) => r.title === title)?.title_kk ?? title : title);
  const q = query.trim().toLowerCase();
  const found = useMemo(
    () =>
      all
        .filter((r) => !draft.roles.includes(r.title))
        .filter((r) => !q || r.title.toLowerCase().includes(q) || r.title_kk.toLowerCase().includes(q))
        .slice(0, q ? 30 : 24),
    [all, draft.roles, q],
  );
  const toggle = (title: string) => {
    if (draft.roles.includes(title)) {
      set({ roles: draft.roles.filter((r) => r !== title) });
      setFull(false);
    } else if (draft.roles.length >= MAX_ROLES) {
      setFull(true);
    } else {
      haptic();
      set({ roles: [...draft.roles, title] });
      setQuery('');
    }
  };
  const custom = query.trim();
  const exact = all.some((r) => r.title.toLowerCase() === q || r.title_kk.toLowerCase() === q);
  return (
    <>
      <Text style={[s.title, { color: c.ink }]}>{t.rolesTitle}</Text>
      <Text style={[s.hint, { color: full ? c.skip : c.quiet }]}>{full ? t.rolesMax : t.rolesHint}</Text>
      {draft.roles.length ? (
        <View style={s.options}>
          {draft.roles.map((r) => (
            <Chip key={r} c={c} active label={`${name(r)} ✕`} onPress={() => toggle(r)} />
          ))}
        </View>
      ) : null}
      <Field c={c} placeholder={t.search} value={query} onChangeText={setQuery} maxLength={60} />
      <View style={s.options}>
        {found.map((r) => (
          <Chip key={r.title} c={c} active={false} label={lang === 'kk' ? r.title_kk : r.title} onPress={() => toggle(r.title)} />
        ))}
        {custom.length >= 3 && !exact ? (
          <Chip c={c} active={false} label={t.addRole(custom)} onPress={() => toggle(custom[0]!.toUpperCase() + custom.slice(1))} />
        ) : null}
      </View>
    </>
  );
}

function OneOf<T extends string>(props: {
  c: Colors;
  lang: Lang;
  title: string;
  items: { value: T; ru: string; kk: string }[];
  value: T | null;
  onPick(v: T): void;
}) {
  const { c, lang, title, items, value, onPick } = props;
  return (
    <>
      <Text style={[s.title, { color: c.ink }]}>{title}</Text>
      <View style={s.column}>
        {items.map((item) => (
          <Chip key={item.value} c={c} big active={value === item.value} label={item[lang]} onPress={() => onPick(item.value)} />
        ))}
      </View>
    </>
  );
}

function Pay({ c, lang, draft, set }: { c: Colors; lang: Lang; draft: Draft; set(p: Partial<Draft>): void }) {
  const t = P[lang];
  return (
    <>
      <Text style={[s.title, { color: c.ink }]}>{t.payTitle}</Text>
      <View style={s.options}>
        {PAY_PERIOD.map((p) => (
          <Chip key={p.value} c={c} active={draft.pay_period === p.value} label={p[lang]} onPress={() => set({ pay_period: p.value, pay: '' })} />
        ))}
      </View>
      <Field
        c={c}
        placeholder={t.payPlaceholder}
        keyboardType="number-pad"
        inputMode="numeric"
        value={draft.pay ? money(Number(draft.pay)) : ''}
        onChangeText={(v) => set({ pay: v.replace(/\D/g, '').slice(0, 8) })}
      />
      <View style={s.options}>
        {PAY_PRESETS[draft.pay_period].map((n) => (
          <Chip key={n} c={c} active={Number(draft.pay) === n} label={`${money(n)} ₸`} onPress={() => set({ pay: String(n) })} />
        ))}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 },
  backText: { fontSize: 16, fontWeight: '600' },
  progress: { paddingHorizontal: 16 },
  body: { padding: 16, gap: 14, paddingBottom: 32 },
  title: { fontSize: 24, fontWeight: '800', lineHeight: 30 },
  hint: { fontSize: 14, marginTop: -8 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  column: { gap: 10 },
  card: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 12 },
  point: { gap: 2 },
  pointHead: { fontSize: 15, fontWeight: '700' },
  pointText: { fontSize: 14, lineHeight: 20 },
  checks: { gap: 8 },
  foot: { padding: 16, paddingTop: 8 },
  error: { fontSize: 15, textAlign: 'center' },
});

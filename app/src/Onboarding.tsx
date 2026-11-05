// Старт из макета vacante 2.0: «Кем работаешь или хочешь?» и «Где и когда удобно?».
// Ответы остаются на телефоне и настраивают ленту; профиль потом берёт их как подсказку.
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Want } from './feed';
import { NEAR_KM, type NearKm, type Point } from './geo';
import * as i18n from './i18n';
import { Icon } from './icons';
import type { Located } from './platform';
import { EMPLOYMENT, EXPERIENCE } from './profile/texts';
import type { Colors } from './theme';
import type { Index, Lang } from './types';
import { Button, Chip, LangSwitch, Screen } from './ui';

const T = {
  ru: {
    rolesTitle: 'Кем работаешь или хочешь?',
    rolesSub: 'Можно выбрать несколько. Телефон пока не нужен.',
    otherRole: 'Другая роль',
    lessRoles: 'Свернуть',
    experience: (role: string) => `Опыт: ${role.toLowerCase()}`,
    experienceAny: 'Опыт работы',
    next: 'Дальше',
    step1: 'Шаг 1 из 2 · около 20 секунд',
    whereTitle: 'Где и когда удобно?',
    whereSub: 'Покажем то, до чего реально добраться.',
    place: 'Где искать',
    locate: 'Рядом со мной — определить',
    located: 'Место определено',
    denied: 'Доступ к геопозиции не дали. Можно включить позже или смотреть весь город.',
    unavailable: 'Телефон не смог определить место. Попробуйте ещё раз или смотрите весь город.',
    placeNote: 'Место остаётся только на этом телефоне.',
    radius: 'Насколько далеко',
    wholeCity: 'весь город',
    when: 'Как удобно работать',
    show: 'Показать вакансии',
    step2: 'Шаг 2 из 2 · телефон попросим только при отклике',
    skip: 'Пропустить',
    back: 'Назад',
  },
  kk: {
    rolesTitle: 'Кім болып жұмыс істейсіз немесе істегіңіз келеді?',
    rolesSub: 'Бірнешеуін таңдауға болады. Телефон әзірге керек емес.',
    otherRole: 'Басқа мамандық',
    lessRoles: 'Жию',
    experience: (role: string) => `Тәжірибе: ${role.toLowerCase()}`,
    experienceAny: 'Жұмыс тәжірибесі',
    next: 'Әрі қарай',
    step1: '2 қадамның 1-і · шамамен 20 секунд',
    whereTitle: 'Қай жерде және қашан ыңғайлы?',
    whereSub: 'Шынымен жетуге болатын жұмыстарды көрсетеміз.',
    place: 'Қай жерден іздеу',
    locate: 'Маған жақын — анықтау',
    located: 'Орын анықталды',
    denied: 'Геолокацияға рұқсат берілмеді. Кейін қосуға немесе бүкіл қаланы қарауға болады.',
    unavailable: 'Телефон орынды анықтай алмады. Қайталап көріңіз немесе бүкіл қаланы қараңыз.',
    placeNote: 'Орын тек осы телефонда қалады.',
    radius: 'Қаншалықты алыс',
    wholeCity: 'бүкіл қала',
    when: 'Қалай жұмыс істеу ыңғайлы',
    show: 'Бос орындарды көрсету',
    step2: '2 қадамның 2-сі · телефонды тек өтінім кезінде сұраймыз',
    skip: 'Өткізу',
    back: 'Артқа',
  },
};

/** Подработка, ночные смены и т. п.: то же, что в анкете профиля. */
const WHEN = EMPLOYMENT.filter((e) => e.value !== 'rotation');
const TOP_ROLES = 8;

export function Onboarding(props: {
  c: Colors;
  lang: Lang;
  index: Index | null;
  initial?: Want;
  here: Point | null;
  near: NearKm | null;
  onLang(l: Lang): void;
  locate(): Promise<Located>;
  onDone(want: Want, here: Point | null, near: NearKm | null): void;
}) {
  const { c, lang, index } = props;
  const t = T[lang];
  const [step, setStep] = useState<1 | 2>(1);
  const [want, setWant] = useState<Want>(props.initial ?? { roles: [], experience: null, employment: [] });
  const [all, setAll] = useState(false);
  const [here, setHere] = useState<Point | null>(props.here);
  const [near, setNear] = useState<NearKm | null>(props.near ?? (props.here ? 5 : null));
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<'denied' | 'unavailable' | null>(null);

  const roles = index?.roles ?? [];
  const shownRoles = all ? roles : roles.slice(0, TOP_ROLES);
  const roleName = (title: string) => {
    const r = roles.find((x) => x.title === title);
    return r ? (lang === 'kk' ? r.title_kk : r.title) : title;
  };
  const toggle = <K extends 'roles' | 'employment'>(key: K, value: Want[K][number]) =>
    setWant((w) => {
      const list = w[key] as string[];
      return { ...w, [key]: list.includes(value) ? list.filter((x) => x !== value) : [...list, value] };
    });

  const locate = async () => {
    setLocating(true);
    setError(null);
    const r = await props.locate();
    setLocating(false);
    if (typeof r === 'string') return setError(r);
    setHere(r);
    setNear((n) => n ?? 5);
  };

  const finish = () => props.onDone(want, here, here ? near : null);

  return (
    <Screen c={c}>
      <View style={styles.top}>
        {step === 2 ? (
          <Pressable onPress={() => setStep(1)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t.back}>
            <Icon name="back" color={c.ink} />
          </Pressable>
        ) : (
          <Text style={[styles.logo, { color: c.accent }]}>vacante</Text>
        )}
        <View style={styles.topRight}>
          <Pressable onPress={finish} hitSlop={8} accessibilityRole="button">
            <Text style={[styles.skip, { color: c.quiet }]}>{t.skip}</Text>
          </Pressable>
          <LangSwitch lang={lang} c={c} onChange={props.onLang} />
        </View>
      </View>
      <ScrollView style={styles.flex} contentContainerStyle={styles.body}>
        {step === 1 ? (
          <>
            <View>
              <Text style={[styles.h1, { color: c.ink }]}>{t.rolesTitle}</Text>
              <Text style={[styles.sub, { color: c.quiet }]}>{t.rolesSub}</Text>
            </View>
            <View style={styles.grid}>
              {shownRoles.map((r) => {
                const on = want.roles.includes(r.title);
                return (
                  <Pressable
                    key={r.title}
                    onPress={() => toggle('roles', r.title)}
                    accessibilityRole="checkbox"
                    aria-checked={on}
                    style={[
                      styles.tile,
                      { backgroundColor: on ? c.strong : c.card, borderColor: on ? c.strong : c.line },
                    ]}
                  >
                    <Text style={[styles.tileText, { color: on ? c.onStrong : c.ink }]} numberOfLines={2}>
                      {lang === 'kk' ? r.title_kk : r.title}
                    </Text>
                    {on ? <Icon name="close" color={c.onStrong} size={16} width={2.5} /> : null}
                  </Pressable>
                );
              })}
              {roles.length > TOP_ROLES ? (
                <Pressable
                  onPress={() => setAll((v) => !v)}
                  accessibilityRole="button"
                  style={[styles.tile, styles.tileWide, { borderColor: c.line, borderStyle: 'dashed' }]}
                >
                  <Text style={[styles.tileText, styles.center, { color: c.quiet }]}>{all ? t.lessRoles : t.otherRole}</Text>
                </Pressable>
              ) : null}
            </View>
            <View style={styles.section}>
              <Text style={[styles.h3, { color: c.ink }]}>
                {want.roles.length === 1 ? t.experience(roleName(want.roles[0]!)) : t.experienceAny}
              </Text>
              <View style={styles.chips}>
                {EXPERIENCE.map((e) => (
                  <Chip
                    key={e.value}
                    c={c}
                    active={want.experience === e.value}
                    label={e[lang]}
                    onPress={() => setWant((w) => ({ ...w, experience: w.experience === e.value ? null : e.value }))}
                  />
                ))}
              </View>
            </View>
          </>
        ) : (
          <>
            <View>
              <Text style={[styles.h1, { color: c.ink }]}>{t.whereTitle}</Text>
              <Text style={[styles.sub, { color: c.quiet }]}>{t.whereSub}</Text>
            </View>
            <View style={styles.section}>
              <Text style={[styles.h3, { color: c.ink }]}>{t.place}</Text>
              <Pressable
                onPress={locate}
                disabled={locating}
                accessibilityRole="button"
                style={[styles.locate, { backgroundColor: here ? c.okBg : c.pill }]}
              >
                {locating ? <ActivityIndicator color={c.accent} /> : <Icon name="pin" color={here ? c.okInk : c.accent} />}
                <Text style={[styles.locateText, { color: here ? c.okInk : c.ink }]}>{here ? t.located : t.locate}</Text>
              </Pressable>
              {error ? <Text style={[styles.sub, { color: c.skip }]}>{t[error]}</Text> : null}
              {here ? (
                <>
                  <Text style={[styles.h3, styles.gap, { color: c.ink }]}>{t.radius}</Text>
                  <View style={styles.chips}>
                    {NEAR_KM.map((km) => (
                      <Chip key={km} c={c} active={near === km} label={i18n.upToKm(km, lang)} onPress={() => setNear(km)} />
                    ))}
                    <Chip c={c} active={near === null} label={t.wholeCity} onPress={() => setNear(null)} />
                  </View>
                </>
              ) : null}
              <Text style={[styles.sub, { color: c.quiet }]}>{t.placeNote}</Text>
            </View>
            <View style={styles.section}>
              <Text style={[styles.h3, { color: c.ink }]}>{t.when}</Text>
              <View style={styles.chips}>
                {WHEN.map((e) => (
                  <Chip
                    key={e.value}
                    c={c}
                    active={want.employment.includes(e.value)}
                    label={e[lang]}
                    onPress={() => toggle('employment', e.value)}
                  />
                ))}
              </View>
            </View>
          </>
        )}
      </ScrollView>
      <View style={styles.foot}>
        {step === 1 ? (
          <Button c={c} label={t.next} onPress={() => setStep(2)} />
        ) : (
          <Button c={c} label={t.show} onPress={finish} />
        )}
        <Text style={[styles.sub, styles.center, { color: c.quiet }]}>{step === 1 ? t.step1 : t.step2}</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8, minHeight: 60 },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  logo: { fontSize: 20, fontWeight: '800', letterSpacing: -0.5 },
  skip: { fontSize: 14, fontWeight: '700' },
  body: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 16, gap: 18 },
  h1: { fontSize: 26, fontWeight: '800', letterSpacing: -0.4, lineHeight: 30 },
  h3: { fontSize: 15, fontWeight: '700' },
  sub: { fontSize: 13, lineHeight: 18, marginTop: 6 },
  gap: { marginTop: 6 },
  center: { textAlign: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: {
    flexBasis: '47%',
    flexGrow: 1,
    minHeight: 56,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  tileWide: { flexBasis: '100%', justifyContent: 'center' },
  tileText: { fontSize: 15, fontWeight: '700', flexShrink: 1 },
  section: { gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  locate: { minHeight: 52, borderRadius: 14, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 10 },
  locateText: { fontSize: 15, fontWeight: '700' },
  foot: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 16, gap: 10 },
});

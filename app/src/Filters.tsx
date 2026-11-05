// Лист «Фильтры» из макета vacante 2.0: роль, график, зарплата от, расстояние, без опыта.
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { matches, PAY_FROM, SCHEDS, schedLabel, type Filter, type Sched } from './feed';
import { NEAR_KM, type NearKm } from './geo';
import * as i18n from './i18n';
import { money } from './profile/texts';
import type { Colors } from './theme';
import type { Index, Lang, Vacancy } from './types';
import { Button, Chip, Seg } from './ui';

const T = {
  ru: {
    title: 'Фильтры',
    reset: 'Сбросить',
    role: 'Профессия',
    all: 'Все',
    sched: 'График',
    pay: 'Зарплата от',
    any: 'Любая',
    distance: 'Расстояние',
    city: 'город',
    locate: 'Определить, где я',
    noExp: 'Можно без опыта',
    show: (n: number) => (n ? `Показать ${i18n.count(n, 'ru')}` : 'Ничего не нашлось'),
  },
  kk: {
    title: 'Сүзгілер',
    reset: 'Тазалау',
    role: 'Мамандық',
    all: 'Барлығы',
    sched: 'Кесте',
    pay: 'Жалақы, бастап',
    any: 'Кез келген',
    distance: 'Қашықтық',
    city: 'қала',
    locate: 'Қай жердемін — анықтау',
    noExp: 'Тәжірибесіз болады',
    show: (n: number) => (n ? `${i18n.count(n, 'kk')} көрсету` : 'Ештеңе табылмады'),
  },
};

/** Сколько профессий показывать в листе, кроме выбранных. */
const ROLES = 10;

export function Filters(props: {
  c: Colors;
  lang: Lang;
  index: Index | null;
  value: Filter;
  near: NearKm | null;
  /** Есть ли точка дома или «рядом со мной»: без неё радиус выбрать нельзя. */
  canNear: boolean;
  /** Вакансии с учётом сферы и уже просмотренных: по ним считаем число на кнопке. */
  pool: Vacancy[];
  /** То же вместе с вакансиями профессий по всему городу: по нему считаем, когда выбрана профессия. */
  rolePool: Vacancy[];
  /** Подгрузить вакансии выбранных профессий по всему городу. */
  onRoles(titles: string[] | undefined): void;
  isNear(v: Vacancy, km: NearKm | null): boolean;
  onLocate(): void;
  onApply(f: Filter, near: NearKm | null): void;
  onClose(): void;
}) {
  const { c, lang, pool } = props;
  const t = T[lang];
  const [f, setF] = useState<Filter>(props.value);
  const [near, setNear] = useState<NearKm | null>(props.near);
  const roles = useMemo(() => {
    const top = (props.index?.roles ?? []).slice(0, ROLES).map((r) => r.title);
    return [...new Set([...(f.roles ?? []), ...top])];
  }, [props.index, f.roles]);
  const roleName = (title: string) => {
    const r = props.index?.roles?.find((x) => x.title === title);
    return r && lang === 'kk' ? r.title_kk : title;
  };
  const { onRoles, rolePool } = props;
  useEffect(() => onRoles(f.roles), [f.roles, onRoles]);
  const count = useMemo(
    () => (f.roles?.length ? rolePool : pool).filter((v) => matches(v, f) && props.isNear(v, near)).length,
    [pool, rolePool, f, near, props],
  );
  const toggle = <T extends string>(list: T[] | undefined, x: T) => {
    const l = list ?? [];
    return l.includes(x) ? l.filter((y) => y !== x) : [...l, x];
  };

  return (
    <View style={styles.backdrop}>
      <Pressable style={styles.flex} onPress={props.onClose} accessibilityLabel={i18n.t(lang, 'close')} />
      <SafeAreaView edges={['bottom']} style={[styles.sheet, { backgroundColor: c.card }]}>
        <View style={[styles.grab, { backgroundColor: c.line }]} />
        <View style={styles.head}>
          <Text style={[styles.h2, { color: c.ink }]}>{t.title}</Text>
          <Pressable
            onPress={() => {
              setF({});
              setNear(null);
            }}
            hitSlop={8}
            accessibilityRole="button"
          >
            <Text style={[styles.reset, { color: c.quiet }]}>{t.reset}</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          <View style={styles.section}>
            <Text style={[styles.h3, { color: c.ink }]}>{t.role}</Text>
            <View style={styles.chips}>
              {roles.map((r) => (
                <Chip key={r} c={c} active={!!f.roles?.includes(r)} label={roleName(r)} onPress={() => setF({ ...f, roles: toggle(f.roles, r) })} />
              ))}
              <Chip c={c} active={!f.roles?.length} label={t.all} onPress={() => setF({ ...f, roles: [] })} />
            </View>
          </View>
          <View style={styles.section}>
            <Text style={[styles.h3, { color: c.ink }]}>{t.sched}</Text>
            <View style={styles.chips}>
              {SCHEDS.map((s) => (
                <Chip
                  key={s}
                  c={c}
                  active={!!f.sched?.includes(s)}
                  label={schedLabel(s, lang)}
                  onPress={() => setF({ ...f, sched: toggle<Sched>(f.sched, s) })}
                />
              ))}
            </View>
          </View>
          <View style={styles.section}>
            <Text style={[styles.h3, { color: c.ink }]}>{t.pay}</Text>
            <View style={styles.chips}>
              <Chip c={c} active={!f.payFrom} label={t.any} onPress={() => setF({ ...f, payFrom: null })} />
              {PAY_FROM.map((p) => (
                <Chip key={p} c={c} active={f.payFrom === p} label={`${money(p)} ₸`} onPress={() => setF({ ...f, payFrom: p })} />
              ))}
            </View>
          </View>
          <View style={styles.section}>
            <Text style={[styles.h3, { color: c.ink }]}>{t.distance}</Text>
            {props.canNear ? (
              <Seg<string>
                c={c}
                value={near ? String(near) : 'city'}
                options={[...NEAR_KM.map((km) => ({ value: String(km), label: `${km} км` })), { value: 'city', label: t.city }]}
                onChange={(v) => setNear(v === 'city' ? null : (Number(v) as NearKm))}
              />
            ) : (
              <Button c={c} ghost icon="pin" label={t.locate} onPress={props.onLocate} />
            )}
          </View>
          <View style={styles.switchRow}>
            <Text style={[styles.h3, { color: c.ink }]}>{t.noExp}</Text>
            <Switch
              value={!!f.noExp}
              onValueChange={(v) => setF({ ...f, noExp: v })}
              trackColor={{ true: c.like, false: c.line }}
              thumbColor="#fff"
              accessibilityLabel={t.noExp}
            />
          </View>
        </ScrollView>
        <View style={styles.foot}>
          <Button c={c} label={t.show(count)} disabled={!count} onPress={() => props.onApply(f, near)} />
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(20,20,19,0.5)', justifyContent: 'flex-end' },
  sheet: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '90%',
    alignSelf: 'center',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 10,
  },
  grab: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 6 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 6 },
  h2: { fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  reset: { fontSize: 14, fontWeight: '700' },
  body: { paddingHorizontal: 20, paddingBottom: 8, gap: 16 },
  section: { gap: 8 },
  h3: { fontSize: 15, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 44 },
  foot: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 16 },
});

// Вакансия в виде vacante 2.0: карточка в ленте «Рядом» и полная страница вакансии.
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { shiftLabel } from './feed';
import { distanceLabel, kmFromHome, type Point } from './geo';
import * as i18n from './i18n';
import { Icon } from './icons';
import { openUrl } from './platform';
import type { Colors } from './theme';
import type { Lang, Vacancy } from './types';
import { Badge, Button } from './ui';

const OSM_COPYRIGHT = 'https://www.openstreetmap.org/copyright';

/** home — дом из профиля: тогда на карточке видно, далеко ли работа. */
type Props = { v: Vacancy; lang: Lang; c: Colors; home?: Point | null };

/**
 * Карточка в ленте: должность, заведение и адрес, зарплата крупно, график и путь от дома,
 * условия бейджами и кнопка отклика. Нажатие открывает вакансию целиком.
 */
export function VacancyCard(props: Props & { reason?: string | null; onOpen(): void; onSave(): void; onApply(): void }) {
  const { v, lang, c, home } = props;
  const pay = i18n.pay(v, lang);
  const monthly = i18n.monthly(v, lang);
  const away = distanceLabel(kmFromHome(home, v), lang, v.approx);
  const perks = i18n.perks(v, lang);
  const where = [v.employer, v.address].filter(Boolean).join(' · ');
  return (
    <Pressable
      onPress={props.onOpen}
      accessibilityRole="button"
      accessibilityLabel={[i18n.title(v, lang), v.employer, pay].filter(Boolean).join(', ')}
      style={[styles.card, { backgroundColor: c.card, borderColor: c.line }]}
    >
      <View style={styles.head}>
        <Avatar v={v} c={c} size={40} />
        <View style={styles.flex}>
          <Text style={[styles.title, { color: c.ink }]} numberOfLines={2}>
            {i18n.title(v, lang)}
          </Text>
          {where ? (
            <Text style={[styles.sub, { color: c.quiet }]} numberOfLines={1}>
              {where}
            </Text>
          ) : null}
        </View>
        <Pressable onPress={props.onSave} hitSlop={10} accessibilityRole="button" accessibilityLabel={i18n.t(lang, 'like')}>
          <Icon name="heart" color={c.faint} />
        </Pressable>
      </View>
      {pay ? (
        <View>
          <Text style={[styles.pay, { color: c.ink }]}>{pay}</Text>
          {monthly ? <Text style={[styles.sub, { color: c.quiet }]}>{monthly}</Text> : null}
        </View>
      ) : (
        <Text style={[styles.noPay, { color: c.quiet }]}>{i18n.t(lang, 'noPay')}</Text>
      )}
      {v.schedule || away ? (
        <View style={styles.facts}>
          {v.schedule ? (
            <View style={styles.factRow}>
              <Icon name="clock" color={c.quiet} size={16} />
              <Text style={[styles.fact, { color: c.ink }]}>{v.schedule}</Text>
            </View>
          ) : null}
          {away ? <Text style={[styles.fact, { color: c.brand }]}>{away}</Text> : null}
        </View>
      ) : null}
      {v.top || v.shift || perks.length ? (
        <View style={styles.badges}>
          {v.top ? <Badge c={c} tone="warn" label={i18n.t(lang, 'urgent')} /> : null}
          {v.shift ? <Badge c={c} tone="ok" label={shiftLabel(v.shift, lang)} /> : null}
          {perks.slice(0, 4).map((p) => (
            <Badge key={p} c={c} label={p} />
          ))}
        </View>
      ) : null}
      {props.reason ? <Text style={[styles.sub, styles.why, { color: c.quiet }]}>{props.reason}</Text> : null}
      <View style={styles.foot}>
        <Text style={[styles.sub, { color: c.quiet }]}>{i18n.age(v.posted_at, lang)}</Text>
        <Button c={c} small label={i18n.t(lang, 'apply')} onPress={props.onApply} />
      </View>
    </Pressable>
  );
}

/** Вакансия целиком: шапка, зарплата, плашки фактов, условия, текст объявления и памятка. */
export function VacancyFull({ v, lang, c, home }: Props) {
  const t = (key: i18n.Key) => i18n.t(lang, key);
  const pay = i18n.pay(v, lang);
  const monthly = i18n.monthly(v, lang);
  const away = distanceLabel(kmFromHome(home, v), lang, v.approx);
  const perks = i18n.perks(v, lang);
  const facts: { label: string; value: string; accent?: boolean }[] = [];
  if (v.schedule) facts.push({ label: t('schedule'), value: v.schedule });
  if (away) facts.push({ label: t('fromHome'), value: away, accent: true });
  facts.push({ label: t('posted'), value: i18n.age(v.posted_at, lang) });
  return (
    <View style={styles.full}>
      <View style={styles.head}>
        <Avatar v={v} c={c} size={56} />
        <View style={styles.flex}>
          <Text style={[styles.h1, { color: c.ink }]}>{i18n.title(v, lang)}</Text>
          {v.employer ? <Text style={[styles.employer, { color: c.accent }]}>{v.employer}</Text> : null}
        </View>
      </View>
      {v.top ? (
        <View style={styles.badges}>
          <Badge c={c} tone="warn" label={t('urgent')} />
        </View>
      ) : null}
      {pay ? (
        <View>
          <Text style={[styles.payBig, { color: c.ink }]}>{pay}</Text>
          {monthly ? <Text style={[styles.sub, { color: c.quiet }]}>{monthly}</Text> : null}
        </View>
      ) : null}
      <View style={styles.grid}>
        {facts.map((f) => (
          <View key={f.label} style={[styles.cell, { backgroundColor: c.soft }]}>
            <Text style={[styles.sub, { color: c.quiet }]}>{f.label}</Text>
            <Text style={[styles.cellValue, { color: f.accent ? c.brand : c.ink }]}>{f.value}</Text>
          </View>
        ))}
      </View>
      {v.address ? (
        <View style={styles.line}>
          <Icon name="pin" color={c.brand} size={20} />
          <Text style={[styles.lineText, { color: c.ink }]}>
            {v.address}
            {/* Точку нашёл OpenStreetMap: лицензия ODbL просит подпись рядом */}
            {v.osm && away ? (
              <Text style={[styles.credit, { color: c.quiet }]} onPress={() => openUrl(OSM_COPYRIGHT)}>
                {' · © OpenStreetMap'}
              </Text>
            ) : null}
          </Text>
        </View>
      ) : null}
      {perks.length ? (
        <View style={styles.section}>
          <Text style={[styles.h3, { color: c.ink }]}>{t('perks')}</Text>
          <View style={styles.badges}>
            {perks.map((p) => (
              <View key={p} style={[styles.chip, { borderColor: c.line }]}>
                <Text style={[styles.chipText, { color: c.ink }]}>{p}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}
      {v.text ? (
        <View style={styles.section}>
          <Text style={[styles.h3, { color: c.ink }]}>{t('about')}</Text>
          <Text style={[styles.text, { color: c.ink }]}>{v.text}</Text>
        </View>
      ) : null}
      <View style={[styles.safety, { backgroundColor: c.warnBg, borderColor: c.warnLine }]}>
        <Icon name="shield" color={c.hot} />
        <Text style={[styles.safetyText, { color: c.warnInk }]}>{t('safety')}</Text>
      </View>
    </View>
  );
}

/** Цвет значка по сфере, как на картинках постов в Telegram (vacante/card.py COLORS). */
const CATEGORY_COLORS: Record<string, string> = {
  horeca: '#e8590c',
  retail: '#0a8ff0',
  warehouse: '#7048e8',
  delivery: '#2b8a3e',
  service: '#0c8599',
  construction: '#e67700',
  callcenter: '#d6336c',
  other: '#495057',
};

export function Avatar({ v, c, size }: { v: Vacancy; c: Colors; size: number }) {
  const box = { width: size, height: size, borderRadius: Math.round(size * 0.29) };
  if (v.avatar) return <Image source={{ uri: v.avatar }} style={[styles.avatar, box]} />;
  const letter = [...(v.employer || v.title)].find((ch) => /[\p{L}\p{N}]/u.test(ch))?.toUpperCase() ?? 'V';
  return (
    <View style={[styles.avatar, box, { backgroundColor: CATEGORY_COLORS[v.category ?? ''] ?? c.strong }]}>
      <Text style={[styles.letter, { color: '#ffffff', fontSize: Math.round(size * 0.42) }]}>{letter}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  card: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 10 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  avatar: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  letter: { fontWeight: '800' },
  title: { fontSize: 18, fontWeight: '700', lineHeight: 23 },
  sub: { fontSize: 13, lineHeight: 18 },
  why: { fontStyle: 'italic' },
  pay: { fontSize: 22, fontWeight: '800', letterSpacing: -0.3 },
  noPay: { fontSize: 15, fontWeight: '600' },
  factRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  facts: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 2 },
  fact: { fontSize: 14, fontWeight: '600' },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 2 },
  full: { padding: 20, paddingTop: 4, gap: 14 },
  h1: { fontSize: 26, fontWeight: '800', letterSpacing: -0.4, lineHeight: 30 },
  employer: { fontSize: 15, fontWeight: '700', marginTop: 4 },
  payBig: { fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { flexGrow: 1, flexBasis: '40%', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, gap: 2 },
  cellValue: { fontSize: 14, fontWeight: '700' },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  lineText: { flex: 1, fontSize: 14, lineHeight: 20, fontWeight: '600' },
  credit: { fontSize: 12, fontWeight: '400' },
  section: { gap: 8 },
  h3: { fontSize: 15, fontWeight: '700' },
  chip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { fontSize: 13, fontWeight: '600' },
  text: { fontSize: 15, lineHeight: 22 },
  safety: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', borderWidth: 1, borderRadius: 16, padding: 14 },
  safetyText: { flex: 1, fontSize: 13, lineHeight: 18 },
});

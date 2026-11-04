import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';

import { distanceLabel, kmFromHome, type Point } from './geo';
import * as i18n from './i18n';
import { openUrl } from './platform';
import type { Colors } from './theme';
import type { Lang, Vacancy } from './types';

const OSM_COPYRIGHT = 'https://www.openstreetmap.org/copyright';

/** home — дом из профиля: тогда на карточке видно, далеко ли работа. */
type Props = { v: Vacancy; lang: Lang; c: Colors; full?: boolean; home?: Point | null };

/** Лицо карточки: главное крупно, чтобы решить за две секунды. full — всё объявление целиком. */
export function VacancyCard({ v, lang, c, full, home }: Props) {
  const pay = i18n.pay(v, lang);
  const monthly = i18n.monthly(v, lang);
  const away = distanceLabel(kmFromHome(home, v), lang, v.approx);
  const chips = [v.schedule, ...i18n.perks(v, lang)].filter(Boolean) as string[];
  const Body = full ? ScrollView : View;
  return (
    <Body style={full ? undefined : styles.fill} contentContainerStyle={full ? styles.pad : undefined}>
      <View style={full ? undefined : [styles.fill, styles.pad]}>
        <View style={styles.head}>
          <Avatar v={v} c={c} />
          <View style={styles.flex}>
            {v.employer ? (
              <Text style={[styles.employer, { color: c.quiet }]} numberOfLines={1}>
                {v.employer}
              </Text>
            ) : null}
            <Text style={[styles.age, { color: c.quiet }]}>
              {v.top ? `${i18n.t(lang, 'urgent')} · ` : ''}
              {i18n.age(v.posted_at, lang)}
            </Text>
          </View>
        </View>
        <Text style={[styles.title, { color: c.ink }]} numberOfLines={full ? undefined : 3}>
          {i18n.title(v, lang)}
        </Text>
        {pay ? <Text style={[styles.pay, { color: c.accent }]}>{pay}</Text> : null}
        {monthly ? <Text style={[styles.monthly, { color: c.quiet }]}>{monthly}</Text> : null}
        {chips.length ? (
          <View style={styles.chips}>
            {chips.slice(0, full ? undefined : 5).map((chip) => (
              <Text key={chip} style={[styles.chip, { backgroundColor: c.pill, color: c.ink }]}>
                {chip}
              </Text>
            ))}
          </View>
        ) : null}
        {away ? (
          <Text style={[styles.away, { color: c.ink }]}>
            🏠 {away}
            {/* Точку нашёл OpenStreetMap: лицензия ODbL просит подпись рядом, в полном объявлении она ссылка */}
            {v.osm ? (
              <Text
                style={[styles.credit, { color: c.quiet }]}
                onPress={full ? () => openUrl(OSM_COPYRIGHT) : undefined}
              >
                {' · © OpenStreetMap'}
              </Text>
            ) : null}
          </Text>
        ) : null}
        {v.address ? (
          <Text style={[styles.address, away ? styles.addressNext : null, { color: c.quiet }]} numberOfLines={full ? undefined : 1}>
            📍 {v.address}
          </Text>
        ) : null}
        {v.text ? (
          <Text
            style={[styles.text, { color: c.ink }, full ? undefined : styles.flex]}
            numberOfLines={full ? undefined : 7}
          >
            {v.text}
          </Text>
        ) : null}
      </View>
    </Body>
  );
}

function Avatar({ v, c }: { v: Vacancy; c: Colors }) {
  if (v.avatar) return <Image source={{ uri: v.avatar }} style={styles.avatar} />;
  const letter = (v.employer || v.title).trim().charAt(0).toUpperCase();
  return (
    <View style={[styles.avatar, { backgroundColor: c.pill }]}>
      <Text style={[styles.letter, { color: c.accent }]}>{letter}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  flex: { flex: 1 },
  pad: { padding: 20 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  letter: { fontSize: 22, fontWeight: '700' },
  employer: { fontSize: 15, fontWeight: '600' },
  age: { fontSize: 13, marginTop: 2 },
  title: { fontSize: 26, fontWeight: '800', lineHeight: 31 },
  pay: { fontSize: 22, fontWeight: '700', marginTop: 10 },
  monthly: { fontSize: 14, marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14 },
  chip: {
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    overflow: 'hidden',
  },
  away: { fontSize: 14, fontWeight: '600', marginTop: 12 },
  credit: { fontSize: 12, fontWeight: '400' },
  address: { fontSize: 14, marginTop: 12 },
  addressNext: { marginTop: 4 },
  text: { fontSize: 15, lineHeight: 21, marginTop: 14, overflow: 'hidden' },
});

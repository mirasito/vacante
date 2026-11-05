// Страница заведения из макета vacante 2.0: аватар, ссылки, адреса и все открытые вакансии
// этого работодателя в ленте города. Отзывы и рейтинг появятся, когда их оставят работники.
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as i18n from './i18n';
import { Icon } from './icons';
import { openUrl } from './platform';
import type { Colors } from './theme';
import type { Lang, Vacancy } from './types';
import { Button } from './ui';
import { Avatar } from './VacancyCard';

const T = {
  ru: {
    addresses: 'Адреса',
    open: (n: number) => `Открытые вакансии · ${n}`,
    site: 'Сайт',
    gis: '2ГИС',
    reviews: 'Отзывов работников пока нет. Они появятся после первых собеседований через Vacante.',
  },
  kk: {
    addresses: 'Мекенжайлар',
    open: (n: number) => `Ашық бос орындар · ${n}`,
    site: 'Сайт',
    gis: '2ГИС',
    reviews: 'Қызметкерлердің пікірлері әзірге жоқ. Олар Vacante арқылы алғашқы сұхбаттардан кейін пайда болады.',
  },
};

/** Вакансии того же работодателя: имя без регистра и лишних пробелов. */
export const sameEmployer = (a: Vacancy, b: Vacancy) =>
  !!a.employer && !!b.employer && a.employer.trim().toLowerCase() === b.employer.trim().toLowerCase();

export function VenueView(props: { v: Vacancy; all: Vacancy[]; lang: Lang; c: Colors; onOpen(v: Vacancy): void }) {
  const { v, lang, c } = props;
  const t = T[lang];
  const list = props.all.filter((x) => sameEmployer(x, v));
  if (!list.some((x) => x.id === v.id)) list.unshift(v);
  const addresses = [...new Set(list.map((x) => x.address).filter(Boolean) as string[])];
  const links = list.find((x) => x.venue)?.venue;
  return (
    <ScrollView contentContainerStyle={styles.body}>
      <View style={styles.head}>
        <Avatar v={list.find((x) => x.avatar) ?? v} c={c} size={56} />
        <View style={styles.flex}>
          <Text style={[styles.h1, { color: c.ink }]}>{v.employer}</Text>
          {addresses.length ? (
            <Text style={[styles.sub, { color: c.quiet }]} numberOfLines={2}>
              {addresses.slice(0, 3).join(', ')}
            </Text>
          ) : null}
        </View>
      </View>
      {links ? (
        <View style={styles.links}>
          {links.instagram ? (
            <Button c={c} small ghost icon="link" label="Instagram" onPress={() => openUrl(`https://instagram.com/${links.instagram}`)} />
          ) : null}
          {links.website ? <Button c={c} small ghost icon="link" label={t.site} onPress={() => openUrl(links.website!)} /> : null}
          {links.gis ? <Button c={c} small ghost icon="map" label={t.gis} onPress={() => openUrl(links.gis!)} /> : null}
        </View>
      ) : null}
      <View style={[styles.note, { backgroundColor: c.soft }]}>
        <Icon name="chat" color={c.quiet} size={20} />
        <Text style={[styles.noteText, { color: c.quiet }]}>{t.reviews}</Text>
      </View>
      <Text style={[styles.h3, { color: c.ink }]}>{t.open(list.length)}</Text>
      <View>
        {list.map((x, i) => (
          <Pressable
            key={x.id}
            onPress={() => props.onOpen(x)}
            accessibilityRole="button"
            style={[styles.line, { borderColor: c.line }, i === list.length - 1 && styles.last]}
          >
            <View style={styles.flex}>
              <Text style={[styles.lineTitle, { color: c.ink }]} numberOfLines={2}>
                {i18n.title(x, lang)}
              </Text>
              {x.address && addresses.length > 1 ? (
                <Text style={[styles.sub, { color: c.quiet }]} numberOfLines={1}>
                  {x.address}
                </Text>
              ) : null}
            </View>
            {i18n.pay(x, lang) ? <Text style={[styles.pay, { color: c.ink }]}>{i18n.pay(x, lang)}</Text> : null}
            <Icon name="next" color={c.faint} size={20} />
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  body: { padding: 20, paddingTop: 4, gap: 14 },
  head: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  h1: { fontSize: 26, fontWeight: '800', letterSpacing: -0.4, lineHeight: 30 },
  h3: { fontSize: 15, fontWeight: '700' },
  sub: { fontSize: 13, lineHeight: 18, marginTop: 4 },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  note: { flexDirection: 'row', gap: 10, borderRadius: 14, padding: 14, alignItems: 'flex-start' },
  noteText: { flex: 1, fontSize: 13, lineHeight: 18 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, borderBottomWidth: 1 },
  last: { borderBottomWidth: 0 },
  lineTitle: { fontSize: 15, fontWeight: '700' },
  pay: { fontSize: 14, fontWeight: '700' },
});

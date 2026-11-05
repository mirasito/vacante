// Страница заведения из макета vacante 2.0: аватар, ссылки, адреса и все открытые вакансии
// этого работодателя в ленте города. Рейтинг из отзывов работников после собеседований: только
// средняя оценка и частые метки, и только когда отзывов три и больше.
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as i18n from './i18n';
import { Icon } from './icons';
import { openUrl } from './platform';
import type { Colors } from './theme';
import type { Lang, Vacancy } from './types';
import { venueReviews, type VenueReviews } from './server';
import { Button } from './ui';
import { V } from './v2texts';
import { Avatar } from './VacancyCard';

const T = {
  ru: {
    addresses: 'Адреса',
    open: (n: number) => `Открытые вакансии · ${n}`,
    site: 'Сайт',
    gis: '2ГИС',
    reviews: 'Отзывов работников пока нет. Они появятся после первых собеседований через Vacante.',
    few: (n: number) => `Отзывов пока ${n}. Рейтинг покажем, когда их будет три.`,
    rating: (n: number) => `по ${n} отзывам работников`,
  },
  kk: {
    addresses: 'Мекенжайлар',
    open: (n: number) => `Ашық бос орындар · ${n}`,
    site: 'Сайт',
    gis: '2ГИС',
    reviews: 'Қызметкерлердің пікірлері әзірге жоқ. Олар Vacante арқылы алғашқы сұхбаттардан кейін пайда болады.',
    few: (n: number) => `Әзірге ${n} пікір. Рейтингті үш пікір болғанда көрсетеміз.`,
    rating: (n: number) => `қызметкерлердің ${n} пікірі бойынша`,
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
  const [reviews, setReviews] = useState<VenueReviews | null>(null);
  useEffect(() => {
    if (v.employer) venueReviews(v.employer).then(setReviews);
  }, [v.employer]);
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
      {reviews?.stars ? (
        <View style={[styles.rating, { backgroundColor: c.soft }]}>
          <View style={styles.ratingHead}>
            <Text style={[styles.ratingNum, { color: c.ink }]}>★ {reviews.stars.toFixed(1)}</Text>
            <Text style={[styles.noteText, { color: c.quiet }]}>{t.rating(reviews.count)}</Text>
          </View>
          <View style={styles.links}>
            {reviews.tags.map((x) => (
              <View key={x.tag} style={[styles.tag, { borderColor: c.line }]}>
                <Text style={[styles.tagText, { color: c.ink }]}>
                  {V[lang].tags[x.tag]} · {x.n}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : (
        <View style={[styles.note, { backgroundColor: c.soft }]}>
          <Icon name="chat" color={c.quiet} size={20} />
          <Text style={[styles.noteText, { color: c.quiet }]}>{reviews?.count ? t.few(reviews.count) : t.reviews}</Text>
        </View>
      )}
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
  rating: { borderRadius: 14, padding: 14, gap: 10 },
  ratingHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  ratingNum: { fontSize: 22, fontWeight: '800' },
  tag: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  tagText: { fontSize: 13, fontWeight: '600' },
  line: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, borderBottomWidth: 1 },
  last: { borderBottomWidth: 0 },
  lineTitle: { fontSize: 15, fontWeight: '700' },
  pay: { fontSize: 14, fontWeight: '700' },
});

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Point } from './geo';
import * as i18n from './i18n';
import { Icon, type IconName } from './icons';
import { haptic, openUrl, shareLink, whatsapp } from './platform';
import type { Colors } from './theme';
import type { Lang, Vacancy } from './types';
import { Button, styles as ui } from './ui';
import { V } from './v2texts';
import { VacancyFull } from './VacancyCard';
import { sameEmployer, VenueView } from './Venue';

function shareVacancy(v: Vacancy, lang: Lang, via: 'any' | 'whatsapp') {
  const pay = i18n.pay(v, lang);
  const text = `${i18n.t(lang, 'shareText')} ${i18n.title(v, lang)}${pay ? ` — ${pay}` : ''}`;
  haptic();
  return via === 'whatsapp' ? whatsapp(text, v.url) : shareLink(text, v.url);
}

/** Страница вакансии из макета: назад, «Поделиться» и «Сохранить» сверху, отклик снизу. */
export function Details(props: {
  v: Vacancy;
  lang: Lang;
  c: Colors;
  home: Point | null;
  /** Вакансии города: для страницы заведения. */
  all: Vacancy[];
  onOther(v: Vacancy): void;
  onClose(): void;
  onSave(): void;
  onApply?(): void;
  /** «Пожаловаться»: только когда вошли через Telegram (жалоба уходит модератору с аккаунтом). */
  onReport?(): void;
}) {
  const { v, lang, c, onClose } = props;
  const t = (key: i18n.Key) => i18n.t(lang, key);
  const [venue, setVenue] = useState(false);
  const others = v.employer ? props.all.filter((x) => sameEmployer(x, v)).length : 0;
  const iconButton = (icon: IconName, label: string, onPress: () => void) => (
    <Pressable onPress={onPress} hitSlop={10} accessibilityRole="button" accessibilityLabel={label} style={styles.iconButton}>
      <Icon name={icon} color={c.ink} />
    </Pressable>
  );
  return (
    <SafeAreaView style={[styles.page, { backgroundColor: c.bg }]} edges={['top', 'bottom']}>
      <View style={ui.column}>
        <View style={styles.pageTop}>
          {iconButton('back', t('back'), venue ? () => setVenue(false) : onClose)}
          {venue ? null : (
            <View style={styles.pageTopRight}>
              {iconButton('share', t('share'), () => shareVacancy(v, lang, 'any'))}
              {iconButton('heart', t('like'), props.onSave)}
            </View>
          )}
        </View>
        {venue ? (
          <VenueView
            v={v}
            all={props.all}
            lang={lang}
            c={c}
            onOpen={(x) => {
              setVenue(false);
              props.onOther(x);
            }}
          />
        ) : (
          <>
            <ScrollView style={ui.flex}>
              <VacancyFull v={v} lang={lang} c={c} home={props.home} />
              {v.employer ? (
                <Pressable
                  onPress={() => setVenue(true)}
                  accessibilityRole="button"
                  style={[styles.venueCard, { borderColor: c.line, backgroundColor: c.card }]}
                >
                  <View style={ui.flex}>
                    <Text style={[styles.venueTitle, { color: c.ink }]}>{t('aboutVenue')}</Text>
                    <Text style={[styles.venueSub, { color: c.quiet }]} numberOfLines={1}>
                      {v.employer}
                      {others > 1 ? ` · ${i18n.count(others, lang)}` : ''}
                    </Text>
                  </View>
                  <Icon name="next" color={c.faint} size={20} />
                </Pressable>
              ) : null}
            </ScrollView>
            <View style={[styles.pageActions, { borderColor: c.line }]}>
              <Button c={c} label={t('apply')} onPress={props.onApply ?? (() => openUrl(v.source_url ?? v.url))} />
              <View style={styles.pageLinks}>
                <Button c={c} small ghost icon="chat" label="WhatsApp" onPress={() => shareVacancy(v, lang, 'whatsapp')} />
                {v.map ? <Button c={c} small ghost icon="map" label={t('onMap')} onPress={() => openUrl(v.map!)} /> : null}
                <Button c={c} small ghost icon="link" label={t('onSite')} onPress={() => openUrl(v.url)} />
                {props.onReport ? <Button c={c} small ghost icon="shield" label={V[lang].report} onPress={props.onReport} /> : null}
              </View>
            </View>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  page: { flex: 1 },
  pageActions: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 16, gap: 10, borderTopWidth: 1 },
  pageLinks: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  pageTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8 },
  pageTopRight: { flexDirection: 'row', gap: 4 },
  venueCard: {
    marginHorizontal: 20,
    marginBottom: 20,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  venueSub: { fontSize: 13, marginTop: 2 },
  venueTitle: { fontSize: 15, fontWeight: '700' },
});

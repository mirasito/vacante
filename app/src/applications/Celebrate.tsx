// Поздравление с новым достижением: показывается один раз, когда сделан настоящий шаг к работе.
import { useEffect } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';

import { haptic } from '../platform';
import type { Achievement, AchievementKind } from '../server';
import type { Colors } from '../theme';
import type { Lang } from '../types';
import { Button } from '../ui';
import { A } from './texts';

export const ICONS: Record<AchievementKind, string> = {
  video: '🎥',
  first_sent: '✉️',
  first_invite: '🎉',
  first_interview: '🤝',
  hired: '💼',
};

export function Celebrate(props: { c: Colors; lang: Lang; list: Achievement[]; onClose(): void }) {
  const { c, lang, list } = props;
  const t = A[lang].achievements;
  useEffect(() => haptic('medium'), []);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={props.onClose}>
      <View style={s.backdrop}>
        <View style={[s.card, { backgroundColor: c.card, borderColor: c.line }]} accessibilityRole="alert">
          <Text style={s.big}>🏅</Text>
          <Text style={[s.title, { color: c.ink }]}>{list.length > 1 ? t.newMany : t.newOne}</Text>
          {list.map((a) => (
            <View key={a.kind} style={s.item}>
              <Text style={[s.name, { color: c.ink }]}>
                {ICONS[a.kind]} {t.names[a.kind]}
              </Text>
              <Text style={[s.why, { color: c.quiet }]}>{t.why[a.kind]}</Text>
            </View>
          ))}
          <View style={s.button}>
            <Button c={c} label={t.ok} onPress={props.onClose} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 360, borderRadius: 24, borderWidth: 1, padding: 24, gap: 12, alignItems: 'center' },
  big: { fontSize: 56 },
  title: { fontSize: 22, fontWeight: '800', textAlign: 'center' },
  item: { alignItems: 'center', gap: 2 },
  name: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  why: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  button: { alignSelf: 'stretch', flexDirection: 'row', marginTop: 4 },
});

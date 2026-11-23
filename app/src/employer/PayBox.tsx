// Реквизиты Kaspi с комментарием к переводу и кнопкой «Я оплатил»: кабинет и форма размещения.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { copyText } from '../platform';
import type { Colors } from '../theme';
import { Button } from '../ui';

/** Реквизиты Kaspi с комментарием и кнопкой «Я оплатил». */
export function PayBox(props: { c: Colors; t: { copy: string; copied: string; payHow: string; paid: string }; kaspi: string; comment: string; busy: boolean; onPaid(): void }) {
  const { c, t } = props;
  const [copied, setCopied] = useState('');
  const copy = (text: string) => {
    if (copyText(text)) setCopied(text);
  };
  return (
    <View style={[styles.pay, { backgroundColor: c.soft, borderColor: c.line }]}>
      <Text style={[styles.small, { color: c.quiet }]}>Kaspi</Text>
      <Pressable onPress={() => copy(props.kaspi)} accessibilityRole="button" style={styles.copyRow}>
        <Text style={[styles.strong, { color: c.ink }]} selectable>
          {props.kaspi}
        </Text>
        <Text style={[styles.link, { color: c.brand }]}>{copied === props.kaspi ? t.copied : t.copy}</Text>
      </Pressable>
      <Text style={[styles.small, { color: c.quiet }]}>{t.payHow}</Text>
      <Pressable onPress={() => copy(props.comment)} accessibilityRole="button" style={styles.copyRow}>
        <Text style={[styles.strong, { color: c.ink }]} selectable>
          {props.comment}
        </Text>
        <Text style={[styles.link, { color: c.brand }]}>{copied === props.comment ? t.copied : t.copy}</Text>
      </Pressable>
      <Button c={c} small label={t.paid} busy={props.busy} onPress={props.onPaid} />
    </View>
  );
}


const styles = StyleSheet.create({
  pay: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 6 },
  copyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  small: { fontSize: 13, lineHeight: 18 },
  strong: { fontSize: 15, fontWeight: '700', flexShrink: 1 },
  link: { fontSize: 14, fontWeight: '600' },
});

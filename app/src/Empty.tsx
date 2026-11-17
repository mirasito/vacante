import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { IconName } from './icons';
import type { Colors } from './theme';
import { IconCircle, styles as ui } from './ui';

/** Пустая лента: значок в сером круге, заголовок, пояснение и кнопки. */
export function Empty(props: { c: Colors; icon: IconName; title: string; text: string; children?: ReactNode }) {
  const { c } = props;
  return (
    <View style={ui.center}>
      <IconCircle c={c} icon={props.icon} />
      <Text style={[ui.h2, { color: c.ink }]}>{props.title}</Text>
      <Text style={[ui.note, { color: c.quiet }]}>{props.text}</Text>
      {/* Кнопки растягиваются по ширине в ряду: здесь обёртка, чтобы не растянулись по высоте */}
      <View style={styles.endActions}>{props.children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  endActions: { alignSelf: 'stretch', gap: 10 },
});

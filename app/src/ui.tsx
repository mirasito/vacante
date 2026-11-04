// Общие кусочки интерфейса: экран, кнопки, чипы, флажки, поля ввода.
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import * as i18n from './i18n';
import type { Colors } from './theme';
import type { Lang } from './types';

export function Screen({ c, children }: { c: Colors; children: ReactNode }) {
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.bg }]}>
      <View style={styles.column}>{children}</View>
    </SafeAreaView>
  );
}

export function Loading({ c, text }: { c: Colors; text: string }) {
  return (
    <View style={[styles.center, { backgroundColor: c.bg }]}>
      <ActivityIndicator color={c.accent} />
      {text ? <Text style={[styles.note, { color: c.quiet }]}>{text}</Text> : null}
    </View>
  );
}

export function Retry({ c, lang, onRetry, text }: { c: Colors; lang: Lang; onRetry(): void; text?: string }) {
  return (
    <View style={styles.center}>
      <Text style={[styles.note, { color: c.quiet }]}>{text ?? i18n.t(lang, 'error')}</Text>
      <Button c={c} label={i18n.t(lang, 'retry')} onPress={onRetry} />
    </View>
  );
}

export function LangSwitch({ lang, c, onChange }: { lang: Lang; c: Colors; onChange(l: Lang): void }) {
  return (
    <View style={[styles.langs, { borderColor: c.line }]}>
      {(['ru', 'kk'] as const).map((l) => (
        <Pressable
          key={l}
          onPress={() => onChange(l)}
          style={[styles.lang, l === lang && { backgroundColor: c.accent }]}
        >
          <Text style={[styles.langText, { color: l === lang ? '#fff' : c.quiet }]}>
            {l === 'ru' ? 'RU' : 'KZ'}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Chip(props: { c: Colors; active: boolean; label: string; onPress(): void; big?: boolean }) {
  const { c, active, label, onPress, big } = props;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[
        styles.chip,
        big && styles.chipBig,
        { backgroundColor: active ? c.accent : c.card, borderColor: active ? c.accent : c.line },
      ]}
    >
      <Text style={[styles.chipText, big && styles.chipTextBig, { color: active ? '#fff' : c.ink }]}>{label}</Text>
    </Pressable>
  );
}

export function Round(props: {
  c: Colors;
  color: string;
  label: string;
  title: string;
  small?: boolean;
  disabled?: boolean;
  onPress(): void;
}) {
  const { c, color, label, title, small, disabled, onPress } = props;
  const size = small ? 48 : 64;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={title}
      style={[
        styles.round,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: c.card, borderColor: c.line },
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.roundText, { color, fontSize: small ? 22 : 30 }]}>{label}</Text>
    </Pressable>
  );
}

export function Tab({ c, active, label, onPress }: { c: Colors; active: boolean; label: string; onPress(): void }) {
  return (
    <Pressable onPress={onPress} style={styles.tab} accessibilityRole="tab" accessibilityState={{ selected: active }}>
      <Text style={[styles.tabText, { color: active ? c.accent : c.quiet }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Button(props: {
  c: Colors;
  label: string;
  ghost?: boolean;
  small?: boolean;
  danger?: boolean;
  disabled?: boolean;
  busy?: boolean;
  onPress(): void;
}) {
  const { c, label, ghost, small, danger, disabled, busy, onPress } = props;
  const color = danger ? c.skip : ghost ? c.ink : '#fff';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      style={[
        styles.button,
        small && styles.buttonSmall,
        ghost || danger ? { borderColor: c.line, borderWidth: 1 } : { backgroundColor: c.accent },
        (disabled || busy) && styles.disabled,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={color} />
      ) : (
        <Text style={[styles.buttonText, small && styles.buttonTextSmall, { color }]}>{label}</Text>
      )}
    </Pressable>
  );
}

/** Флажок с подписью: нажимается вся строка. */
export function Check(props: { c: Colors; checked: boolean; label: string; hint?: string; onPress(): void }) {
  const { c, checked, label, hint, onPress } = props;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      style={[styles.check, { borderColor: checked ? c.accent : c.line, backgroundColor: c.card }]}
    >
      <View style={[styles.box, { borderColor: checked ? c.accent : c.quiet, backgroundColor: checked ? c.accent : 'transparent' }]}>
        {checked ? <Text style={styles.tick}>✓</Text> : null}
      </View>
      <View style={styles.flex}>
        <Text style={[styles.checkText, { color: c.ink }]}>{label}</Text>
        {hint ? <Text style={[styles.hint, { color: c.quiet }]}>{hint}</Text> : null}
      </View>
    </Pressable>
  );
}

export function Field(props: TextInputProps & { c: Colors; label?: string }) {
  const { c, label, style, ...input } = props;
  return (
    <View style={styles.field}>
      {label ? <Text style={[styles.label, { color: c.quiet }]}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={c.quiet}
        {...input}
        style={[styles.input, { color: c.ink, borderColor: c.line, backgroundColor: c.card }, style]}
      />
    </View>
  );
}

/** Полоска прогресса: сила профиля, шаг анкеты. */
export function Bar({ c, value }: { c: Colors; value: number }) {
  return (
    <View style={[styles.bar, { backgroundColor: c.line }]}>
      <View style={[styles.barFill, { backgroundColor: c.accent, width: `${Math.max(0, Math.min(100, value))}%` }]} />
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1 },
  column: { flex: 1, width: '100%', maxWidth: 520, alignSelf: 'center' },
  flex: { flex: 1 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  big: { fontSize: 48 },
  h1: { fontSize: 28, fontWeight: '800', paddingHorizontal: 16, marginBottom: 12 },
  h2: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  note: { fontSize: 15, textAlign: 'center', lineHeight: 21 },
  langs: { flexDirection: 'row', borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
  lang: { paddingHorizontal: 10, paddingVertical: 5 },
  langText: { fontSize: 13, fontWeight: '700' },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: 1 },
  chipBig: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 14 },
  chipText: { fontSize: 14, fontWeight: '600' },
  chipTextBig: { fontSize: 16 },
  round: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  roundText: { fontWeight: '700' },
  disabled: { opacity: 0.4 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 14, paddingHorizontal: 4 },
  tabText: { fontSize: 15, fontWeight: '700' },
  button: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    minHeight: 50,
  },
  buttonSmall: { flexGrow: 0, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, minHeight: 0 },
  buttonText: { fontSize: 16, fontWeight: '700', textAlign: 'center' },
  buttonTextSmall: { fontSize: 14 },
  check: { flexDirection: 'row', gap: 12, padding: 14, borderRadius: 14, borderWidth: 1, alignItems: 'flex-start' },
  box: { width: 24, height: 24, borderRadius: 7, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  tick: { color: '#fff', fontSize: 15, fontWeight: '900', lineHeight: 18 },
  checkText: { fontSize: 15, lineHeight: 21, fontWeight: '600' },
  hint: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  field: { gap: 6 },
  label: { fontSize: 13, fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
  bar: { height: 8, borderRadius: 4, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
});

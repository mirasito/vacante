// Общие кусочки интерфейса: экран, кнопки, чипы, флажки, поля ввода.
import type { ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

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

/** Отступы внутри Modal. На телефоне окну нужен свой провайдер. В вебе свой провайдер мерит себя
 *  посреди выезда окна и даёт снизу отступ в высоту экрана, поэтому там берём внешний. */
export function ModalArea({ children }: { children: ReactNode }) {
  return Platform.OS === 'web' ? <>{children}</> : <SafeAreaProvider>{children}</SafeAreaProvider>;
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
      aria-selected={active}
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

/**
 * Вкладка внизу: значок, подпись под ним и счётчик на значке. alert — счётчик того, что пора
 * сделать (красный), иначе это просто число (серый).
 */
export function Tab(props: { c: Colors; active: boolean; icon: string; label: string; badge?: number; alert?: boolean; onPress(): void }) {
  const { c, active, icon, label, badge, alert, onPress } = props;
  return (
    <Pressable
      onPress={onPress}
      style={styles.tab}
      accessibilityRole="tab"
      aria-selected={active}
      accessibilityLabel={badge ? `${label}: ${badge}` : label}
    >
      <View>
        <Text style={[styles.tabIcon, !active && styles.tabIconQuiet]}>{icon}</Text>
        {badge ? (
          <View style={[styles.badge, { backgroundColor: alert ? c.skip : c.quiet, borderColor: c.card }]}>
            <Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
          </View>
        ) : null}
      </View>
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
      aria-checked={checked}
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

/**
 * Кольцо прогресса из обычных View, без SVG: по половине круга поворачивается под маской
 * каждой стороны. segments делит кольцо на доли, по одной на отклик цели.
 */
export function Ring(props: {
  size: number;
  width: number;
  /** 0–1, с 12 часов по часовой стрелке. */
  progress: number;
  color: string;
  track: string;
  /** Цвет середины и промежутков между долями: фон карточки. */
  hole: string;
  segments?: number;
  children?: ReactNode;
}) {
  const { size: d, width, color, track, hole, segments = 0 } = props;
  const p = Math.max(0, Math.min(1, props.progress));
  const r = d / 2;
  const gap = 3;
  // Правая половина заполняется с 12 до 6 часов, левая с 6 до 12
  const right = Math.min(p, 0.5) * 360;
  const left = Math.max(0, p - 0.5) * 360;
  const half = (side: 'left' | 'right', angle: number) => (
    <View style={{ position: 'absolute', top: 0, left: side === 'right' ? r : 0, width: r, height: d, overflow: 'hidden' }}>
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: side === 'right' ? -r : 0,
          width: d,
          height: d,
          transform: [{ rotate: `${angle}deg` }],
        }}
      >
        {angle > 0 ? (
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: side === 'right' ? 0 : r,
              width: r,
              height: d,
              backgroundColor: color,
              ...(side === 'right'
                ? { borderTopLeftRadius: r, borderBottomLeftRadius: r }
                : { borderTopRightRadius: r, borderBottomRightRadius: r }),
            }}
          />
        ) : null}
      </View>
    </View>
  );
  return (
    <View
      style={{ width: d, height: d, borderRadius: r, overflow: 'hidden', backgroundColor: p >= 1 ? color : track }}
      accessibilityRole="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p * 100)}
    >
      {p < 1 ? half('right', right) : null}
      {p < 1 ? half('left', left) : null}
      {segments > 1
        ? Array.from({ length: segments }, (_, i) => (
            <View
              key={i}
              style={{
                position: 'absolute',
                top: 0,
                left: r - gap / 2,
                width: gap,
                height: d,
                transform: [{ rotate: `${(360 / segments) * i}deg` }],
              }}
            >
              <View style={{ width: gap, height: r, backgroundColor: hole }} />
            </View>
          ))
        : null}
      <View
        style={{
          position: 'absolute',
          top: width,
          left: width,
          width: d - 2 * width,
          height: d - 2 * width,
          borderRadius: r - width,
          backgroundColor: hole,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {props.children}
      </View>
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
  tab: { flex: 1, alignItems: 'center', paddingTop: 8, paddingBottom: 6, paddingHorizontal: 2, gap: 2 },
  tabIcon: { fontSize: 21, lineHeight: 26, textAlign: 'center' },
  tabIconQuiet: { opacity: 0.55 },
  tabText: { fontSize: 11, fontWeight: '700' },
  badge: {
    position: 'absolute',
    top: -3,
    left: 16,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '800', lineHeight: 12 },
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

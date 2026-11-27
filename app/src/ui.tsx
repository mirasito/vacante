// Общие кусочки интерфейса: экран, кнопки, чипы, флажки, поля ввода.
import { type ComponentRef, type ReactNode, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type TextProps } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { Icon, type IconName } from './icons';
import * as i18n from './i18n';
import type { Colors } from './theme';
import type { Lang } from './types';

/** Логотип «.вакантэ» с поварским колпаком: тёмный на светлой теме, белый на тёмной. */
export function Logo({ c, height = 28 }: { c: Colors; height?: number }) {
  return (
    <Image
      source={c.mode === 'dark' ? require('../assets/logo-light.png') : require('../assets/logo-dark.png')}
      style={{ height, width: Math.round((height * 516) / 124) }}
      resizeMode="contain"
      accessibilityLabel="вакантэ"
    />
  );
}

/**
 * Экран приложения. role=main: скринридер прыгает к содержимому. hidden — поверх открыто окно:
 * Modal в вебе рисуется отдельно в body, а экран под ним прячем от скринридера, чтобы свайпом
 * по экрану не уйти из окна в ленту под ним.
 */
export function Screen({ c, children, hidden }: { c: Colors; children: ReactNode; hidden?: boolean }) {
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.bg }]}>
      <View style={styles.column} role="main" aria-hidden={hidden || undefined}>
        {children}
      </View>
    </SafeAreaView>
  );
}

/**
 * Пробел для radio, checkbox и tab. react-native-web нажимает пробелом только role=button,
 * а у настоящих флажков и переключателей пробел — главная клавиша (Enter у них работает и так).
 */
export function spaceKey(onPress: () => void): object {
  if (Platform.OS !== 'web') return {};
  return {
    onKeyDown: (e: { key?: string; nativeEvent?: { key?: string }; preventDefault(): void }) => {
      const key = e.key ?? e.nativeEvent?.key;
      if (key === ' ' || key === 'Spacebar') {
        e.preventDefault();
        onPress();
      }
    },
  };
}

/**
 * Затемнение под листом снизу: нажатие мышью или пальцем закрывает лист. Это не кнопка и не цель Tab:
 * с клавиатуры лист закрывают Escape и крестик. Pressable здесь не годится: он всегда focusable, и окно
 * при открытии ставило фокус на безымянное затемнение вместо заголовка.
 */
export function Backdrop({ onClose }: { onClose(): void }) {
  return <View style={styles.flex} onStartShouldSetResponder={() => true} onResponderRelease={onClose} />;
}

/**
 * Область объявлений (aria-live): есть на экране всегда, иначе первое сообщение в только что вставленном
 * блоке часто не объявляется. Пустая она вне потока, чтобы gap родителя не давал лишний отступ.
 */
export function Live({ children }: { children: ReactNode }) {
  return (
    <View aria-live="polite" style={children ? undefined : styles.liveEmpty}>
      {children}
    </View>
  );
}

/** Заголовок окна принимает фокус программно (tabIndex -1): окно при открытии ставит фокус на него. */
export const focusTarget: object = Platform.OS === 'web' ? { tabIndex: -1 } : {};

/**
 * Кнопка-«прыжок» для клавиатуры: видна, только пока в фокусе. Лента догружается без конца, и Tab-ом
 * через неё до нижнего меню не дойти (WCAG 2.4.1).
 */
export function SkipLink({ c, label, onPress }: { c: Colors; label: string; onPress(): void }) {
  const [shown, setShown] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onFocus={() => setShown(true)}
      onBlur={() => setShown(false)}
      accessibilityRole="button"
      style={shown ? [styles.skip, { backgroundColor: c.strong }] : styles.srOnly}
    >
      <Text style={[styles.skipText, { color: c.onStrong }]}>{label}</Text>
    </Pressable>
  );
}

/** Имя окна (Modal): иначе скринридер объявляет просто «диалог». В вебе RNW отдаёт его role=dialog. */
export const dialogName = (label: string): object => ({ 'aria-label': label });

/** Заголовок для скринридера: по заголовкам он прыгает по экрану. */
export const heading = (level: 1 | 2 | 3 = 1) => ({ role: 'heading' as const, 'aria-level': level });

/**
 * Заголовок экрана (h1). Появился — забирает фокус: после выбора города или шага старта фокус иначе
 * остаётся на исчезнувшей кнопке, то есть в body, и место приходится искать заново. hidden — заголовок
 * только для скринридера (у ленты видимого заголовка нет).
 */
export function ScreenTitle(props: { style?: TextProps['style']; hidden?: boolean; level?: 1 | 2 | 3; children: ReactNode }) {
  const { style, hidden, level = 1, children } = props;
  const ref = useRef<ComponentRef<typeof Text>>(null);
  useEffect(() => {
    if (Platform.OS === 'web') (ref.current as unknown as { focus?(): void } | null)?.focus?.();
  }, []);
  return (
    <Text ref={ref} style={hidden ? styles.srOnly : style} {...heading(level)} {...focusTarget}>
      {children}
    </Text>
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

/** Переключатель языка RU · KZ: серая дорожка, выбранный язык на белом. */
export function LangSwitch({ lang, c, onChange }: { lang: Lang; c: Colors; onChange(l: Lang): void }) {
  return (
    <Seg
      c={c}
      small
      label={i18n.t(lang, 'chooseLang')}
      value={lang}
      options={[
        { value: 'ru', label: 'RU' },
        { value: 'kk', label: 'KZ' },
      ]}
      onChange={onChange}
    />
  );
}

/** Сегменты на серой дорожке: выбранный — белый. */
export function Seg<T extends string>(props: {
  c: Colors;
  value: T;
  options: { value: T; label: string }[];
  label?: string;
  small?: boolean;
  onChange(v: T): void;
}) {
  const { c, value, options, label, small, onChange } = props;
  return (
    <View style={[styles.seg, { backgroundColor: c.pill }]} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            {...spaceKey(() => onChange(o.value))}
            accessibilityRole="radio"
            aria-checked={on}
            style={[styles.segItem, small && styles.segSmall, on && [styles.segOn, { backgroundColor: c.card }]]}
          >
            <Text style={[styles.segText, small && styles.segTextSmall, { color: on ? c.ink : c.quiet }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Бейдж: ok — зелёный («Проверен»), warn — янтарный, иначе серый. */
export function Badge({ c, label, tone }: { c: Colors; label: string; tone?: 'ok' | 'warn' }) {
  const bg = tone === 'ok' ? c.okBg : tone === 'warn' ? c.warnBg : c.pill;
  const color = tone === 'ok' ? c.okInk : tone === 'warn' ? c.hot : c.quiet;
  return (
    <View style={[styles.badgeChip, { backgroundColor: bg }]}>
      <Text style={[styles.badgeChipText, { color }]}>{label}</Text>
    </View>
  );
}

export function Chip(props: {
  c: Colors;
  active: boolean;
  label: string;
  onPress(): void;
  big?: boolean;
  icon?: IconName;
  /** false — чип просто кнопка (открывает окно, возвращает скрытое): у него нет состояния «нажата». */
  toggle?: boolean;
}) {
  const { c, active, label, onPress, big, icon, toggle = true } = props;
  const color = active ? c.onStrong : c.ink;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      // Кнопка-переключатель: «нажата» (aria-pressed), а не «выбрана». aria-selected у кнопки недопустим,
      // из-за него PageSpeed ругался на роли ARIA и снимал оценку «Agentic Browsing» у формы работодателя
      aria-pressed={toggle ? active : undefined}
      style={[
        styles.chip,
        big && styles.chipBig,
        { backgroundColor: active ? c.strong : c.card, borderColor: active ? c.strong : c.line },
      ]}
    >
      {icon ? <Icon name={icon} color={active ? c.onStrong : c.accent} size={16} /> : null}
      <Text style={[styles.chipText, big && styles.chipTextBig, { color }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * Вкладка внизу: значок, подпись под ним и счётчик на значке. alert — счётчик того, что пора
 * сделать (красный), иначе это просто число (серый).
 */
export function Tab(props: { c: Colors; active: boolean; icon: IconName; label: string; badge?: number; alert?: boolean; onPress(): void }) {
  const { c, active, icon, label, badge, alert, onPress } = props;
  const color = active ? c.accent : c.quiet;
  return (
    <Pressable
      onPress={onPress}
      {...spaceKey(onPress)}
      style={styles.tab}
      accessibilityRole="tab"
      aria-selected={active}
      accessibilityLabel={badge ? `${label}: ${badge}` : label}
    >
      <View>
        <Icon name={icon} color={color} />
        {badge ? (
          <View style={[styles.badge, { backgroundColor: alert ? c.accent : c.quiet, borderColor: c.card }]}>
            <Text style={[styles.badgeText, { color: alert ? c.onAccent : c.onStrong }]}>{badge > 99 ? '99+' : badge}</Text>
          </View>
        ) : null}
      </View>
      <Text style={[styles.tabText, { color }]} numberOfLines={1}>
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
  /**
   * Пока идёт запрос. Кнопка не отключается (отключённая <button> теряет фокус, и он улетает в начало
   * страницы), а говорит «занята» (aria-busy) и не нажимается второй раз.
   */
  busy?: boolean;
  /**
   * Выглядит неактивной, но остаётся в порядке Tab и нажимается: onPress сам объясняет, чего не хватает.
   * Отключённую кнопку «Дальше» клавиатура и скринридер просто не находят.
   */
  blocked?: boolean;
  /** id текста, который объясняет кнопку (например «Осталось заполнить: …»). */
  describedBy?: string;
  icon?: IconName;
  onPress(): void;
}) {
  const { c, label, ghost, small, danger, disabled, busy, blocked, describedBy, icon, onPress } = props;
  const color = danger ? c.skip : ghost ? c.ink : c.onAccent;
  return (
    <Pressable
      onPress={busy ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      aria-busy={busy || undefined}
      aria-describedby={describedBy}
      // Пока крутится индикатор, подписи нет: имя кнопки оставляем
      accessibilityLabel={busy ? label : undefined}
      style={[
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: ghost || danger ? c.pill : c.accent },
        (disabled || busy || blocked) && styles.disabled,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={color} />
      ) : (
        <>
          {icon ? <Icon name={icon} color={color} size={small ? 18 : 20} /> : null}
          <Text style={[styles.buttonText, small && styles.buttonTextSmall, { color }]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

/** Значок в сером круге: пустые списки. */
export function IconCircle({ c, icon }: { c: Colors; icon: IconName }) {
  return (
    <View style={[styles.iconCircle, { backgroundColor: c.pill }]}>
      <Icon name={icon} color={c.quiet} size={28} />
    </View>
  );
}

/** Флажок с подписью: нажимается вся строка. */
export function Check(props: { c: Colors; checked: boolean; label: string; hint?: string; onPress(): void }) {
  const { c, checked, label, hint, onPress } = props;
  return (
    <Pressable
      onPress={onPress}
      {...spaceKey(onPress)}
      accessibilityRole="checkbox"
      aria-checked={checked}
      style={[styles.check, { borderColor: c.line, backgroundColor: c.card }]}
    >
      <View style={[styles.box, { borderColor: checked ? c.like : c.control, backgroundColor: checked ? c.like : 'transparent' }]}>
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
      {label ? <Text style={[styles.label, { color: c.ink }]}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={c.quiet}
        // Подпись над полем видна глазами, а скринридеру её надо отдать явно: иначе у поля нет имени
        // (например «Имя для работодателя» в анкете перед первым откликом)
        accessibilityLabel={label}
        {...input}
        style={[styles.input, { color: c.ink, borderColor: c.control, backgroundColor: c.card }, style]}
      />
    </View>
  );
}

/** Полоска прогресса: сила профиля, шаг анкеты. */
export function Bar({ c, value }: { c: Colors; value: number }) {
  return (
    <View style={[styles.bar, { backgroundColor: c.line }]}>
      <View style={[styles.barFill, { backgroundColor: c.brand, width: `${Math.max(0, Math.min(100, value))}%` }]} />
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
  /** Что показывает кольцо: без имени progressbar для скринридера просто «45 процентов». */
  label?: string;
  children?: ReactNode;
}) {
  const { size: d, width, color, track, hole, segments = 0, label } = props;
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
      aria-label={label}
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
  liveEmpty: { position: 'absolute', width: 1, height: 1, overflow: 'hidden' },
  srOnly: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 },
  skip: { position: 'absolute', top: 4, left: 16, zIndex: 10, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12 },
  skipText: { fontSize: 15, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  big: { fontSize: 48 },
  h1: { fontSize: 26, fontWeight: '800', letterSpacing: -0.4, lineHeight: 30, paddingHorizontal: 20, marginBottom: 12 },
  h2: { fontSize: 20, fontWeight: '800', letterSpacing: -0.3, textAlign: 'center' },
  note: { fontSize: 15, textAlign: 'center', lineHeight: 21 },
  seg: { flexDirection: 'row', borderRadius: 12, padding: 4 },
  segItem: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 9, paddingHorizontal: 6, borderRadius: 9 },
  segSmall: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', paddingVertical: 5, paddingHorizontal: 10, borderRadius: 8 },
  segOn: {
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  segText: { fontSize: 14, fontWeight: '700' },
  segTextSmall: { fontSize: 13 },
  badgeChip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  badgeChipText: { fontSize: 12, fontWeight: '700' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderWidth: 1,
  },
  chipBig: { minHeight: 48, paddingHorizontal: 16, borderRadius: 14 },
  chipText: { fontSize: 14, fontWeight: '600' },
  chipTextBig: { fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  iconCircle: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  tab: { flex: 1, alignItems: 'center', paddingTop: 10, paddingBottom: 8, paddingHorizontal: 2, gap: 4 },
  tabText: { fontSize: 11, fontWeight: '700' },
  badge: {
    position: 'absolute',
    top: -5,
    left: 14,
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
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    minHeight: 52,
  },
  buttonSmall: { flexGrow: 0, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 12, minHeight: 40 },
  buttonText: { fontSize: 16, fontWeight: '700', textAlign: 'center' },
  buttonTextSmall: { fontSize: 14 },
  check: { flexDirection: 'row', gap: 12, padding: 14, borderRadius: 14, borderWidth: 1, alignItems: 'flex-start' },
  box: { width: 24, height: 24, borderRadius: 7, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  tick: { color: '#fff', fontSize: 15, fontWeight: '900', lineHeight: 18 },
  checkText: { fontSize: 15, lineHeight: 21, fontWeight: '600' },
  hint: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  field: { gap: 6 },
  label: { fontSize: 15, fontWeight: '700' },
  input: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, minHeight: 52 },
  bar: { height: 8, borderRadius: 4, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
});

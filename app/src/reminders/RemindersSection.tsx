// Раздел «Напоминания» в профиле: ближайшие три и настройки — какие включены, присылать ли
// их в бот. Тихие часы общие для всех (с 21:00 до 9:00), поэтому их только показываем.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { whenRelative } from '../applications/texts';
import { haptic } from '../platform';
import { REMINDER_GROUPS, saveReminderSettings, type ReminderGroup, type Reminders } from '../server';
import type { Colors } from '../theme';
import type { Lang } from '../types';
import { Button, Check } from '../ui';
import { titleOf } from './RemindersTab';
import { R } from './texts';

export function RemindersSection(props: {
  c: Colors;
  lang: Lang;
  data: Reminders | null;
  /** Бот может писать первым: без этого напоминание в чат не дойдёт. */
  writeAccess: boolean;
  onChange(next: Reminders): void;
  onOpenAll(): void;
  onAllowBot(): void;
}) {
  const { c, lang, data } = props;
  const t = R[lang];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!data) return null;
  const { settings } = data;
  const now = Date.now();
  const next = data.reminders.filter((r) => r.active).slice(0, 3);

  const save = async (off: ReminderGroup[], bot: boolean) => {
    haptic();
    setBusy(true);
    setError('');
    try {
      props.onChange(await saveReminderSettings({ off, bot }));
    } catch {
      setError(t.failed);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (g: ReminderGroup) =>
    save(settings.off.includes(g) ? settings.off.filter((x) => x !== g) : [...settings.off, g], settings.bot);

  return (
    <View style={s.box}>
      <Text style={[s.section, { color: c.ink }]}>{t.section}</Text>
      <Text style={[s.caption, { color: c.quiet }]}>{t.next}</Text>
      {next.length ? (
        next.map((r) => (
          <Text key={r.id} style={[s.small, { color: c.ink }]} numberOfLines={2}>
            {whenRelative(r.due_at, lang, now)} · {titleOf(r, lang)}
            {r.application ? ` · ${(lang === 'kk' && r.application.title_kk) || r.application.title}` : ''}
          </Text>
        ))
      ) : (
        <Text style={[s.small, { color: c.quiet }]}>{t.none}</Text>
      )}
      <Pressable onPress={props.onOpenAll} hitSlop={8}>
        <Text style={[s.link, { color: c.accent }]}>{t.all}</Text>
      </Pressable>

      {REMINDER_GROUPS.map((g) => (
        <Check key={g} c={c} checked={!settings.off.includes(g)} label={t.groups[g]} onPress={() => !busy && void toggle(g)} />
      ))}
      <Check
        c={c}
        checked={settings.bot}
        label={t.bot}
        hint={settings.bot ? t.botHint : t.botOff}
        onPress={() => !busy && void save(settings.off, !settings.bot)}
      />
      {settings.bot && !props.writeAccess ? (
        <View style={s.allow}>
          <Text style={[s.small, { color: c.quiet }]}>{t.allowBotHint}</Text>
          <Button c={c} small ghost label={t.allowBot} onPress={props.onAllowBot} />
        </View>
      ) : null}
      {error ? <Text style={[s.small, { color: c.skip }]}>{error}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  box: { gap: 8 },
  section: { fontSize: 17, fontWeight: '700', marginTop: 8 },
  caption: { fontSize: 13, fontWeight: '600' },
  small: { fontSize: 14, lineHeight: 20 },
  link: { fontSize: 14, fontWeight: '700', marginBottom: 4 },
  allow: { gap: 6, alignItems: 'flex-start' },
});

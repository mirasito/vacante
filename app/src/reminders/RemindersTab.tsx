// Вкладка «Напоминания»: сегодня, завтра, позже и история. У каждого напоминания кнопка
// следующего шага (как в боте), а ещё «Через час» и «Убрать». Своё добавляется кнопкой сверху.
import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { days, toIso, type Focus } from '../applications/ApplicationsTab';
import { dayLabel, whenRelative } from '../applications/texts';
import { haptic, openUrl } from '../platform';
import { almaty, when } from '../profile/texts';
import { actOnReminder, addReminder, type Reminder, type Reminders, type Stage } from '../server';
import type { Colors } from '../theme';
import type { Lang } from '../types';
import { Button, Chip, Field, Loading, ModalArea, Retry, styles as ui } from '../ui';
import { R } from './texts';

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

const ICONS: Record<Reminder['kind'], string> = {
  write_again: '✉️',
  status_check: '❓',
  interview_eve: '📅',
  interview_soon: '⏰',
  how_was_it: '🤝',
  start_eve: '💼',
  profile: '🎥',
  week: '📊',
  custom: '🔔',
};

/** Полночь по времени Казахстана (UTC+5), миллисекунды UTC. */
export const dayStart = (ms: number) => {
  const t = almaty(ms);
  return Date.UTC(t.year, t.month, t.day) - 5 * 3600_000;
};

const timeOf = (iso: string) => {
  const t = almaty(Date.parse(iso));
  return `${pad(t.hour)}:${pad(t.minute)}`;
};

export const titleOf = (r: Reminder, lang: Lang) => (r.kind === 'custom' ? (r.text ?? '') : R[lang].kinds[r.kind]);

/** Что ждёт сегодня (и уже наступило), завтра и позже. */
export function split(list: Reminder[], now: number) {
  const today = dayStart(now);
  const active = list.filter((r) => r.active);
  return {
    today: active.filter((r) => Date.parse(r.due_at) < today + DAY),
    tomorrow: active.filter((r) => Date.parse(r.due_at) >= today + DAY && Date.parse(r.due_at) < today + 2 * DAY),
    later: active.filter((r) => Date.parse(r.due_at) >= today + 2 * DAY),
    history: list.filter((r) => !r.active),
  };
}

export type Write = 'again' | 'late';

export function RemindersTab(props: {
  c: Colors;
  lang: Lang;
  data: Reminders | null;
  failed: boolean;
  onRetry(): void;
  onChange(next: Reminders): void;
  /** Написать работодателю готовым текстом; после этого напоминание сделано. */
  onWrite(r: Reminder, kind: Write): void;
  onOpenApplication(id: number, focus: Focus): void;
  /** Ответ работодателя кнопкой напоминания: стадия отклика. */
  onStage(applicationId: number, stage: Stage): Promise<void>;
  onRecord(): void;
  onTab(tab: 'applications' | 'feed'): void;
}) {
  const { c, lang, data } = props;
  const t = R[lang];
  const [adding, setAdding] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState('');
  const now = Date.now();
  const parts = split(data?.reminders ?? [], now);

  if (props.failed && !data) return <Retry c={c} lang={lang} onRetry={props.onRetry} />;
  if (!data) return <Loading c={c} text="" />;

  const run = async (r: Reminder, work: () => Promise<Reminders | void>) => {
    haptic();
    setBusy(r.id);
    setError('');
    try {
      const next = await work();
      if (next) props.onChange(next);
    } catch {
      setError(t.failed);
    } finally {
      setBusy(null);
    }
  };
  const act = (r: Reminder, action: 'done' | 'dismiss' | 'snooze') => run(r, () => actOnReminder(r.id, action));
  // Сначала отмечаем напоминание, потом стадию: иначе сервер сам закроет его как ненужное
  const stage = (r: Reminder, next: Stage) =>
    run(r, async () => {
      const after = await actOnReminder(r.id, 'done');
      props.onChange(after);
      if (r.application) await props.onStage(r.application.id, next);
    });

  const sections: [string, Reminder[]][] = [
    [t.today, parts.today],
    [t.tomorrow, parts.tomorrow],
    [t.later, parts.later],
  ];
  const nothing = !parts.today.length && !parts.tomorrow.length && !parts.later.length;

  return (
    <View style={ui.flex}>
      <ScrollView contentContainerStyle={s.body}>
        <View style={s.head}>
          <Text style={[s.title, { color: c.ink }]}>{t.title}</Text>
          <Button c={c} small label={t.add} onPress={() => setAdding(true)} />
        </View>
        {error ? <Text style={[s.error, { color: c.skip }]}>{error}</Text> : null}
        {nothing ? (
          <View style={s.empty}>
            <Text style={ui.big}>🔔</Text>
            <Text style={[ui.note, { color: c.quiet }]}>{t.empty}</Text>
          </View>
        ) : null}

        {sections.map(([title, items], i) =>
          items.length ? (
            <View key={title} style={s.group}>
              <Text style={[s.groupTitle, { color: c.quiet }]}>
                {title} · {items.length}
              </Text>
              {items.map((r) => (
                <Item
                  key={r.id}
                  r={r}
                  c={c}
                  lang={lang}
                  now={now}
                  later={i === 2}
                  busy={busy === r.id}
                  onAct={(action) => act(r, action)}
                  onStage={(next) => stage(r, next)}
                  onWrite={(kind) => props.onWrite(r, kind)}
                  onOpenApplication={props.onOpenApplication}
                  onRecord={props.onRecord}
                  onTab={props.onTab}
                />
              ))}
            </View>
          ) : null,
        )}

        {parts.history.length ? (
          <>
            <Button
              c={c}
              ghost
              small
              label={showHistory ? t.hideHistory : t.showHistory(parts.history.length)}
              onPress={() => setShowHistory((v) => !v)}
            />
            {showHistory ? (
              <View style={s.group}>
                {parts.history.map((r) => (
                  <View key={r.id} style={[s.past, { borderColor: c.line }]}>
                    <Text style={[s.pastTitle, { color: c.quiet }]} numberOfLines={2}>
                      {ICONS[r.kind]} {titleOf(r, lang)}
                      {r.application ? ` · ${(lang === 'kk' && r.application.title_kk) || r.application.title}` : ''}
                    </Text>
                    <Text style={[s.small, { color: c.quiet }]}>
                      {t.status[r.status]} · {when(r.due_at, lang)}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        ) : null}

        <Text style={[s.rules, { color: c.quiet }]}>{t.rules}</Text>
      </ScrollView>

      <Modal visible={adding} animationType="slide" transparent onRequestClose={() => setAdding(false)}>
        <ModalArea>
          {adding ? (
            <AddSheet
              c={c}
              lang={lang}
              onClose={() => setAdding(false)}
              onAdded={(next) => {
                props.onChange(next);
                setAdding(false);
              }}
            />
          ) : null}
        </ModalArea>
      </Modal>
    </View>
  );
}

function Item(props: {
  r: Reminder;
  c: Colors;
  lang: Lang;
  now: number;
  later: boolean;
  busy: boolean;
  onAct(action: 'done' | 'dismiss' | 'snooze'): void;
  onStage(stage: Stage): void;
  onWrite(kind: Write): void;
  onOpenApplication(id: number, focus: Focus): void;
  onRecord(): void;
  onTab(tab: 'applications' | 'feed'): void;
}) {
  const { r, c, lang, now, busy } = props;
  const t = R[lang];
  const a = r.application;
  const due = Date.parse(r.due_at);
  const time = props.later ? whenRelative(r.due_at, lang, now) : due <= now ? t.now : t.at(timeOf(r.due_at));
  const appTitle = a ? (lang === 'kk' && a.title_kk) || a.title : '';
  const lines: string[] = [];
  if (a) lines.push([appTitle, a.employer].filter(Boolean).join(' · '));
  if ((r.kind === 'interview_eve' || r.kind === 'interview_soon') && a?.interview_at) {
    lines.push(t.interviewAt(whenRelative(a.interview_at, lang, now)));
    if (a.address) lines.push(`📍 ${a.address}`);
  }
  if (r.kind === 'start_eve') {
    if (a?.start_at) lines.push(t.startAt(dayLabel(a.start_at, lang)));
    if (a?.address) lines.push(`📍 ${a.address}`);
    lines.push(t.hints.bring);
  }
  if (r.kind === 'write_again') lines.push(t.hints.write_again);
  if (r.kind === 'status_check') lines.push(t.hints.status_check);
  if (r.kind === 'profile') lines.push(t.hints.profile);
  if (r.kind === 'week' && r.week) lines.push(t.week(r.week.sent, r.week.seen, r.week.invited));

  const b = (label: string, onPress: () => void, ghost = false) => (
    <Button key={label} c={c} small ghost={ghost} label={label} disabled={busy} onPress={onPress} />
  );
  const map = a?.map ? b(t.actions.map, () => openUrl(a.map!), true) : null;
  const buttons = (() => {
    switch (r.kind) {
      case 'write_again':
        return [b(t.actions.write, () => props.onWrite('again'))];
      case 'status_check':
        return [
          b(t.actions.invited, () => props.onStage('invited')),
          b(t.actions.rejected, () => props.onStage('rejected'), true),
          b(t.actions.silence, () => props.onStage('no_answer'), true),
        ];
      case 'interview_eve':
      case 'interview_soon':
        return [
          map,
          b(t.actions.late, () => props.onWrite('late'), true),
          a ? b(t.actions.move, () => props.onOpenApplication(a.id, 'interview'), true) : null,
        ];
      case 'how_was_it':
        return [
          b(t.actions.offer, () => props.onStage('offer')),
          b(t.actions.rejected, () => props.onStage('rejected'), true),
          b(t.actions.wait, () => props.onAct('done'), true),
        ];
      case 'start_eve':
        return [map, b(t.actions.done, () => props.onAct('done'), !!map)];
      case 'profile':
        return [b(t.actions.record, props.onRecord)];
      case 'week':
        return [b(t.actions.apps, () => props.onTab('applications')), b(t.actions.feed, () => props.onTab('feed'), true)];
      case 'custom':
        return [b(t.actions.done, () => props.onAct('done'))];
    }
  })().filter(Boolean);

  return (
    <View style={[s.item, { backgroundColor: c.card, borderColor: due <= now ? c.accent : c.line }]}>
      <View style={s.itemHead}>
        <Text style={[s.itemTitle, { color: c.ink }]}>
          {ICONS[r.kind]} {titleOf(r, lang)}
        </Text>
        <Text style={[s.time, { color: due <= now ? c.accent : c.quiet }]}>{time}</Text>
      </View>
      {lines.map((line, i) => (
        <Text key={i} style={[s.small, { color: i === 0 && a ? c.ink : c.quiet }]}>
          {line}
        </Text>
      ))}
      <View style={[ui.row, s.buttons]}>{buttons}</View>
      <View style={s.quiet}>
        {/* Отложить можно то, что уже наступило */}
        {due <= now ? (
          <Pressable onPress={() => props.onAct('snooze')} disabled={busy} hitSlop={8}>
            <Text style={[s.link, { color: c.quiet }]}>{t.actions.snooze}</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => props.onAct('dismiss')} disabled={busy} hitSlop={8}>
          <Text style={[s.link, { color: c.quiet }]}>{t.actions.dismiss}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Время для своего напоминания: с 9:00 до 21:00, в это время бот и пишет. */
const TIMES = Array.from({ length: 25 }, (_, i) => `${pad(9 + Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`);

/** Первое время в окне: через час от сейчас (до получаса вверх), а если сегодня уже поздно — завтра в 10:00. */
function firstSlot(now: number, lang: Lang) {
  const list = days(2, lang, now);
  const later = almaty(now + 3600_000);
  const minutes = Math.ceil((later.hour * 60 + later.minute) / 30) * 30;
  const sameDay = later.day === almaty(now).day;
  if (sameDay && minutes < 9 * 60) return { day: list[0]!.value, time: '10:00' };
  if (sameDay && minutes <= 21 * 60) return { day: list[0]!.value, time: `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}` };
  return { day: list[1]!.value, time: '10:00' };
}

function AddSheet(props: { c: Colors; lang: Lang; onClose(): void; onAdded(next: Reminders): void }) {
  const { c, lang } = props;
  const t = R[lang];
  const now = Date.now();
  const first = useMemo(() => firstSlot(now, lang), [now, lang]);
  const [text, setText] = useState('');
  const [day, setDay] = useState(first.day);
  const [time, setTime] = useState(first.time);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const at = toIso(day, time);
  const past = Date.parse(at) < now;

  const save = async () => {
    haptic();
    setBusy(true);
    setError('');
    try {
      props.onAdded(await addReminder(text.trim(), at));
    } catch {
      setError(t.failed);
      setBusy(false);
    }
  };

  return (
    <View style={s.backdrop}>
      <SafeAreaView style={[s.sheet, { backgroundColor: c.card }]} edges={['bottom']}>
        <Pressable onPress={props.onClose} style={s.close} hitSlop={12} accessibilityLabel="✕">
          <Text style={[s.closeText, { color: c.quiet }]}>✕</Text>
        </Pressable>
        <ScrollView style={s.scroll} contentContainerStyle={s.sheetBody} keyboardShouldPersistTaps="handled">
          <Text style={[s.title, { color: c.ink }]}>{t.newTitle}</Text>
          <Field c={c} label={t.newText} value={text} onChangeText={setText} placeholder={t.newPlaceholder} maxLength={120} />
          <Text style={[s.label, { color: c.quiet }]}>{t.newDay}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
            {days(14, lang, now).map((x) => (
              <Chip key={x.value} c={c} active={day === x.value} label={x.label} onPress={() => setDay(x.value)} />
            ))}
          </ScrollView>
          <Text style={[s.label, { color: c.quiet }]}>{t.newTime}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
            {TIMES.map((x) => (
              <Chip key={x} c={c} active={time === x} label={x} onPress={() => setTime(x)} />
            ))}
          </ScrollView>
          <Text style={[s.small, { color: c.quiet }]}>{t.newHint}</Text>
          <Button c={c} label={t.newSave} busy={busy} disabled={!text.trim() || past} onPress={save} />
          {error ? <Text style={[s.error, { color: c.skip }]}>{error}</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  body: { padding: 16, gap: 12, paddingBottom: 32 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  title: { fontSize: 22, fontWeight: '800' },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 40 },
  group: { gap: 8 },
  groupTitle: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 4 },
  item: { padding: 14, borderRadius: 16, borderWidth: 1, gap: 4 },
  itemHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' },
  itemTitle: { flex: 1, fontSize: 16, fontWeight: '700', lineHeight: 21 },
  time: { fontSize: 14, fontWeight: '700' },
  small: { fontSize: 14, lineHeight: 20 },
  buttons: { marginTop: 6 },
  quiet: { flexDirection: 'row', gap: 18, marginTop: 8 },
  link: { fontSize: 13, fontWeight: '600' },
  past: { borderBottomWidth: 1, paddingVertical: 8, gap: 2 },
  pastTitle: { fontSize: 14, fontWeight: '600' },
  rules: { fontSize: 13, lineHeight: 18, marginTop: 8 },
  error: { fontSize: 14, textAlign: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '92%',
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: 'hidden',
  },
  scroll: { flexGrow: 0 },
  close: { position: 'absolute', top: 14, right: 18, zIndex: 2 },
  closeText: { fontSize: 22 },
  sheetBody: { padding: 20, gap: 10, paddingBottom: 28 },
  label: { fontSize: 13, fontWeight: '600', marginTop: 4 },
  chips: { gap: 6, paddingVertical: 2 },
});

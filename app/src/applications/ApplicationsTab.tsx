// Вкладка «Отклики»: общая стадия поиска полоской, сводка недели одной строкой, цель недели кольцом
// с серией недель, достижения, отклики по группам с кнопкой следующего шага и карточка отклика:
// стадия, собеседование, день выхода, заметка, история.
import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { confirm, haptic, openUrl } from '../platform';
import { almaty, when } from '../profile/texts';
import {
  ACHIEVEMENTS,
  getApplication,
  GOALS,
  type Achievement,
  type AchievementKind,
  type Application,
  type ApplicationPatch,
  type Goal,
  type GoalValue,
  type Stage,
  type Summary,
} from '../server';
import type { Colors } from '../theme';
import type { Lang } from '../types';
import { Button, Chip, Field, IconCircle, Loading, ModalArea, Retry, Ring, Seg, styles as ui } from '../ui';
import { ICONS } from './Celebrate';
import { CLOSED, SEARCH } from './model';
import { A, dayLabel, whenRelative } from './texts';

const DAY = 86_400_000;
type Next = 'apply' | 'again' | 'contact' | 'setInterview' | 'how' | 'map' | 'setStart' | 'hired';
export type Focus = 'interview' | 'start' | 'how' | null;

/** Одна кнопка следующего шага (иногда две), как в таблице стадий ТЗ. */
export function nextSteps(a: Application, now: number): Next[] {
  switch (a.stage) {
    case 'liked':
      return ['apply'];
    case 'sent':
      // Через 2 дня тишины — «Написать ещё раз»
      return a.sent_at && now - Date.parse(a.sent_at) > 2 * DAY ? ['again'] : [];
    case 'seen':
      return ['contact'];
    case 'invited':
      return ['setInterview'];
    case 'interview': {
      const past = !!a.interview_at && Date.parse(a.interview_at) < now;
      const steps: Next[] = [];
      if (past) steps.push('how');
      else if (!a.interview_at) steps.push('setInterview');
      if (a.vacancy.map && !past) steps.push('map');
      return steps;
    }
    case 'offer':
      return a.start_at ? ['hired'] : ['setStart', 'hired'];
    default:
      return [];
  }
}

function status(a: Application, lang: Lang, now: number): string {
  const t = A[lang].status;
  if (a.stage === 'interview' && a.interview_at) return t.interview(whenRelative(a.interview_at, lang, now));
  if ((a.stage === 'offer' || a.stage === 'hired') && a.start_at) return t.start(dayLabel(a.start_at, lang));
  if (a.seen_at && (a.stage === 'seen' || a.stage === 'invited')) return t.seen(when(a.seen_at, lang));
  if (a.stage === 'sent' && a.sent_at) return `${t.sent(dayLabel(a.sent_at, lang))} · ${t.waiting}`;
  if (a.stage === 'liked') return t.liked(dayLabel(a.created_at, lang));
  return dayLabel(a.updated_at, lang);
}

const GROUPS: { key: keyof (typeof A)['ru']['groups']; stages: Stage[] }[] = [
  { key: 'interviews', stages: ['interview'] },
  { key: 'work', stages: ['offer', 'hired'] },
  { key: 'waiting', stages: ['invited', 'seen', 'sent'] },
  { key: 'liked', stages: ['liked'] },
  { key: 'closed', stages: CLOSED },
];

type Part = 'active' | 'saved' | 'history';
const PART: Record<(typeof GROUPS)[number]['key'], Part> = {
  interviews: 'active',
  work: 'active',
  waiting: 'active',
  liked: 'saved',
  closed: 'history',
};

export function ApplicationsTab(props: {
  c: Colors;
  lang: Lang;
  items: Application[] | null;
  summary: Summary | null;
  /** Профиля нет: отклики живут на телефоне. */
  local: boolean;
  failed: boolean;
  onRetry(): void;
  /** again — «Написать ещё раз»: вместо отклика вежливое напоминание о себе. */
  onApply(a: Application, again?: boolean): void;
  onPatch(a: Application, patch: ApplicationPatch): Promise<Application>;
  onDelete(a: Application): Promise<void>;
  onMakeProfile(): void;
  /** Цель недели: 3, 5 или 10 откликов, null — без цели. */
  onGoal(goal: GoalValue | null): Promise<void>;
  /** Открыть карточку отклика: из ссылки бота или кнопкой «Перенести» в напоминании. */
  show?: { id: number; focus: Focus } | null;
  onShown?(): void;
  /** Экран «Запись» vacante 2.0 (только с профилем на сервере). */
  onBooking?(a: Application): void;
}) {
  const { c, lang, items, summary, local, show, onShown } = props;
  const t = A[lang];
  const [open, setOpen] = useState<{ a: Application; focus: Focus } | null>(null);

  useEffect(() => {
    if (!show || !items) return;
    const a = items.find((x) => x.id === show.id);
    if (a) setOpen({ a, focus: show.focus });
    onShown?.();
  }, [show, items, onShown]);
  // Вкладки из макета vacante 2.0: в работе, сохранённые (ещё без отклика) и завершённые
  const [part, setPart] = useState<Part>('active');
  const now = Date.now();

  const groups = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        items: (items ?? [])
          .filter((a) => g.stages.includes(a.stage))
          .sort((x, y) =>
            g.key === 'interviews'
              ? Date.parse(x.interview_at ?? x.updated_at) - Date.parse(y.interview_at ?? y.updated_at)
              : Date.parse(y.updated_at) - Date.parse(x.updated_at),
          ),
      })),
    [items],
  );

  if (props.failed && !items) return <Retry c={c} lang={lang} onRetry={props.onRetry} />;
  if (!items) return <Loading c={c} text="" />;

  const act = (a: Application, step: Next) => {
    haptic();
    if (step === 'apply' || step === 'again' || step === 'contact') return props.onApply(a, step === 'again');
    if (step === 'map' && a.vacancy.map) return openUrl(a.vacancy.map);
    if (step === 'hired') return void props.onPatch(a, { stage: 'hired' }).catch(() => undefined);
    // С профилем время, собеседование и «Как прошло?» живут на экране «Запись»
    if (props.onBooking && a.id > 0 && (step === 'setInterview' || step === 'how')) return props.onBooking(a);
    setOpen({ a, focus: step === 'setInterview' ? 'interview' : step === 'setStart' ? 'start' : 'how' });
  };

  const current = summary ? SEARCH.indexOf(summary.stage) : 0;
  const next = summary?.next_interview;
  const count = (p: Part) => groups.filter((g) => PART[g.key] === p).reduce((n, g) => n + g.items.length, 0);
  const shown = groups.filter((g) => PART[g.key] === part && g.items.length);

  return (
    <View style={ui.flex}>
      <ScrollView contentContainerStyle={s.body}>
        <Seg<Part>
          c={c}
          value={part}
          onChange={setPart}
          options={(['active', 'saved', 'history'] as const).map((p) => ({
            value: p,
            label: count(p) ? `${t.segments[p]} · ${count(p)}` : t.segments[p],
          }))}
        />
        {part === 'active' ? (
        <>
        <View style={[s.top, { backgroundColor: c.card, borderColor: c.line }]}>
          <View style={s.bar}>
            {SEARCH.map((stage, i) => (
              <View key={stage} style={[s.segment, { backgroundColor: i <= current ? c.brand : c.line }]} />
            ))}
          </View>
          <View style={s.barLabels}>
            <Text style={[s.stageNow, { color: c.accent }]}>{t.search[SEARCH[current] ?? 'looking']}</Text>
            {current < SEARCH.length - 1 ? (
              <Text style={[s.stageNext, { color: c.quiet }]}>→ {t.search[SEARCH[current + 1]!]}</Text>
            ) : null}
          </View>
          {summary && items.length ? (
            <Text style={[s.week, { color: c.ink }]}>{t.week(summary.week.sent, summary.week.seen, summary.week.invited)}</Text>
          ) : null}
          {next ? (
            <Pressable
              onPress={() => {
                const a = items.find((x) => x.id === next.id);
                if (a && props.onBooking) props.onBooking(a);
                else if (a) setOpen({ a, focus: null });
              }}
            >
              <Text style={[s.next, { color: c.ink }]}>
                📅 {t.nextInterview(whenRelative(next.at, lang, now))}
                {next.employer ? ` · ${next.employer}` : ''}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {summary ? <GoalCard c={c} lang={lang} goal={summary.goal} onGoal={props.onGoal} /> : null}
        {summary && !local ? <Achievements c={c} lang={lang} list={summary.achievements} /> : null}

        {local ? (
          <View style={[s.local, { backgroundColor: c.pill }]}>
            <Text style={[s.localTitle, { color: c.ink }]}>📱 {t.localTitle}</Text>
            <Text style={[s.small, { color: c.ink }]}>{t.localText}</Text>
            <View style={ui.row}>
              <Button c={c} small label={A[lang].makeProfile} onPress={props.onMakeProfile} />
            </View>
          </View>
        ) : null}

        </>
        ) : null}

        {!shown.length ? (
          <View style={s.empty}>
            <IconCircle c={c} icon={part === 'history' ? 'clock' : 'heart'} />
            <Text style={[ui.note, { color: c.quiet }]}>
              {part === 'saved' ? t.emptySaved : part === 'history' ? t.emptyHistory : t.empty}
            </Text>
          </View>
        ) : null}

        {shown.map((g) => (
            <View key={g.key} style={s.group}>
              <Text style={[s.groupTitle, { color: c.quiet }]}>
                {t.groups[g.key]} · {g.items.length}
              </Text>
              {g.items.map((a) => (
                <Row key={a.id} a={a} c={c} lang={lang} now={now} onOpen={() => setOpen({ a, focus: null })} onAct={act} />
              ))}
            </View>
        ))}
      </ScrollView>

      <Modal visible={!!open} animationType="slide" transparent onRequestClose={() => setOpen(null)}>
        <ModalArea>
          {open ? (
            <Detail
              key={open.a.id}
              c={c}
              lang={lang}
              initial={items.find((x) => x.id === open.a.id) ?? open.a}
              focus={open.focus}
              local={local}
              onClose={() => setOpen(null)}
              onPatch={props.onPatch}
              onApply={(a, again) => {
                setOpen(null);
                props.onApply(a, again);
              }}
              onDelete={async (a) => {
                await props.onDelete(a);
                setOpen(null);
              }}
            />
          ) : null}
        </ModalArea>
      </Modal>
    </View>
  );
}

/** Цель недели: выбор 3, 5 или 10 откликов, потом кольцо прогресса и серия недель. */
function GoalCard(props: { c: Colors; lang: Lang; goal: Goal; onGoal(goal: GoalValue | null): Promise<void> }) {
  const { c, lang, goal } = props;
  const t = A[lang].goal;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pick = async (value: GoalValue | null) => {
    if (busy) return;
    haptic();
    setBusy(true);
    setError('');
    try {
      await props.onGoal(value);
      setEditing(false);
    } catch {
      setError(t.failed);
    } finally {
      setBusy(false);
    }
  };

  if (!goal.goal || editing) {
    return (
      <View style={[s.top, { backgroundColor: c.card, borderColor: c.line }]}>
        <Text style={[s.goalTitle, { color: c.ink }]}>{t.title}</Text>
        <Text style={[s.small, { color: c.ink }]}>{t.ask}</Text>
        <View style={ui.row}>
          {GOALS.map((g) => (
            <Chip key={g} c={c} big active={goal.goal === g} label={String(g)} onPress={() => void pick(g)} />
          ))}
          {goal.goal ? <Chip c={c} big active={false} label={t.off} onPress={() => void pick(null)} /> : null}
        </View>
        {editing ? (
          <View style={ui.row}>
            <Button c={c} small ghost label={t.cancel} onPress={() => setEditing(false)} />
          </View>
        ) : (
          <Text style={[s.small, { color: c.quiet }]}>{t.hint}</Text>
        )}
        {error ? <Text style={[s.small, { color: c.skip }]}>{error}</Text> : null}
      </View>
    );
  }

  const done = goal.sent >= goal.goal;
  return (
    <View style={[s.top, s.goalRow, { backgroundColor: c.card, borderColor: c.line }]}>
      <Ring
        size={78}
        width={9}
        progress={goal.sent / goal.goal}
        segments={goal.goal}
        color={done ? c.like : c.accent}
        track={c.line}
        hole={c.card}
      >
        <Text style={[s.ringNumber, { color: c.ink }]}>
          {goal.sent}/{goal.goal}
        </Text>
      </Ring>
      <View style={s.goalText}>
        <Text style={[s.goalTitle, { color: c.ink }]}>{t.of(goal.goal)}</Text>
        <Text style={[s.small, done ? { color: c.like, fontWeight: '700' } : { color: c.quiet }]}>
          {done ? t.done : t.left(goal.goal - goal.sent)}
        </Text>
        {goal.streak ? <Text style={[s.small, { color: c.ink, fontWeight: '600' }]}>{t.streak(goal.streak)}</Text> : null}
        {goal.forgiven ? <Text style={[s.hint, { color: c.quiet }]}>{t.forgiven}</Text> : null}
        <Pressable onPress={() => setEditing(true)} hitSlop={8} accessibilityRole="button">
          <Text style={[s.link, { color: c.accent }]}>{t.change}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Пять достижений: каждое — настоящий шаг к работе. Нажатие подсказывает, как его получить. */
function Achievements({ c, lang, list }: { c: Colors; lang: Lang; list: Achievement[] }) {
  const t = A[lang].achievements;
  const got = new Map(list.map((a) => [a.kind, a]));
  const [hint, setHint] = useState<AchievementKind | null>(null);
  const shown = hint ? got.get(hint) : undefined;
  return (
    <View style={[s.top, { backgroundColor: c.card, borderColor: c.line }]}>
      <Text style={[s.groupTitle, s.flat, { color: c.quiet }]}>
        {t.title} · {t.count(got.size, ACHIEVEMENTS.length)}
      </Text>
      <View style={s.badges}>
        {ACHIEVEMENTS.map((kind) => {
          const has = got.has(kind);
          return (
            <Pressable
              key={kind}
              style={s.badge}
              onPress={() => setHint(hint === kind ? null : kind)}
              accessibilityRole="button"
              accessibilityLabel={has ? t.names[kind] : `${t.names[kind]}: ${t.how[kind]}`}
            >
              <View style={[s.badgeIcon, { backgroundColor: has ? c.pill : c.bg, borderColor: has ? c.accent : c.line }]}>
                <Text style={[s.badgeEmoji, !has && s.locked]}>{ICONS[kind]}</Text>
              </View>
              <Text style={[s.badgeText, { color: has ? c.ink : c.quiet }]} numberOfLines={2}>
                {t.names[kind]}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {hint ? (
        <Text style={[s.small, { color: c.quiet }]}>
          {t.names[hint]}: {shown ? when(shown.at, lang) : t.how[hint]}
        </Text>
      ) : null}
    </View>
  );
}

function StageChip({ stage, c, lang }: { stage: Stage; c: Colors; lang: Lang }) {
  const good = stage === 'invited' || stage === 'interview' || stage === 'offer' || stage === 'hired';
  const closed = CLOSED.includes(stage);
  return (
    <View style={[s.chip, { backgroundColor: good ? c.like : closed ? c.line : c.pill }]}>
      <Text style={[s.chipText, { color: good ? '#fff' : c.ink }]}>{A[lang].stages[stage]}</Text>
    </View>
  );
}

function Row(props: { a: Application; c: Colors; lang: Lang; now: number; onOpen(): void; onAct(a: Application, step: Next): void }) {
  const { a, c, lang, now } = props;
  const t = A[lang];
  const title = (lang === 'kk' && a.vacancy.title_kk) || a.vacancy.title;
  const steps = nextSteps(a, now);
  return (
    <Pressable onPress={props.onOpen} style={[s.row, { backgroundColor: c.card, borderColor: c.line }]}>
      <View style={s.rowHead}>
        <Text style={[s.rowTitle, { color: c.ink }]} numberOfLines={2}>
          {title}
        </Text>
        <StageChip stage={a.stage} c={c} lang={lang} />
      </View>
      {a.vacancy.employer ? (
        <Text style={{ color: c.quiet }} numberOfLines={1}>
          {a.vacancy.employer}
        </Text>
      ) : null}
      <Text style={[s.status, { color: c.quiet }]}>{status(a, lang, now)}</Text>
      {a.unread ? <Text style={[s.status, { color: c.accent, fontWeight: '700' }]}>💬 {a.unread}</Text> : null}
      {steps.length ? (
        <View style={ui.row}>
          {steps.map((step, i) => (
            <Button key={step} c={c} small ghost={i > 0} label={t.next[step]} onPress={() => props.onAct(a, step)} />
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Следующие n дней по времени Казахстана: значение ГГГГ-ММ-ДД и подпись «Сегодня», «Завтра», «Пт 6». */
export function days(n: number, lang: Lang, from = Date.now()) {
  const t = A[lang];
  return Array.from({ length: n }, (_, i) => {
    const d = almaty(from + i * DAY);
    const value = `${d.year}-${pad(d.month + 1)}-${pad(d.day)}`;
    const name = i === 0 ? t.today : i === 1 ? t.tomorrow : `${t.weekdays[d.weekday]} ${d.day}`;
    return { value, label: name[0]!.toUpperCase() + name.slice(1) };
  });
}

const TIMES = Array.from({ length: 25 }, (_, i) => `${pad(8 + Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`);

/** День и время Казахстана → ISO в UTC. */
export const toIso = (day: string, time: string) => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, d, h, mi) - 5 * 3600_000).toISOString();
};

function Detail(props: {
  c: Colors;
  lang: Lang;
  initial: Application;
  focus: Focus;
  local: boolean;
  onClose(): void;
  onPatch(a: Application, patch: ApplicationPatch): Promise<Application>;
  onApply(a: Application, again?: boolean): void;
  onDelete(a: Application): Promise<void>;
}) {
  const { c, lang, local } = props;
  const t = A[lang];
  const d = t.detail;
  const [a, setA] = useState(props.initial);
  const [events, setEvents] = useState(props.initial.events ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const at = a.interview_at ? almaty(Date.parse(a.interview_at)) : null;
  const [day, setDay] = useState(at ? `${at.year}-${pad(at.month + 1)}-${pad(at.day)}` : '');
  const [time, setTime] = useState(at ? `${pad(at.hour)}:${pad(at.minute)}` : '');
  const [start, setStart] = useState(a.start_at ?? '');
  const [note, setNote] = useState(a.note ?? '');
  const [editDate, setEditDate] = useState(props.focus === 'interview');
  const now = Date.now();

  useEffect(() => {
    if (local || a.id < 0) return;
    let alive = true;
    getApplication(a.id).then(
      (x) => {
        if (!alive) return;
        setA(x);
        setEvents(x.events ?? []);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [a.id, local]);

  const save = async (patch: ApplicationPatch) => {
    haptic();
    setBusy(true);
    setError('');
    try {
      const next = await props.onPatch(a, patch);
      setA(next);
      if (next.events) setEvents(next.events);
      return true;
    } catch {
      setError(t.saveError);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!(await confirm(local ? d.removeLocal : d.removeConfirm, d.yes, d.no))) return;
    setBusy(true);
    try {
      await props.onDelete(a);
    } catch {
      setError(t.saveError);
      setBusy(false);
    }
  };

  const title = (lang === 'kk' && a.vacancy.title_kk) || a.vacancy.title;
  const stages: Stage[] = ['liked', 'sent', 'invited', 'interview', 'offer', 'hired', 'rejected', 'no_answer', 'not_interested'];
  const pastInterview = a.stage === 'interview' && !!a.interview_at && Date.parse(a.interview_at) < now;
  const steps = nextSteps(a, now).filter((x) => x === 'apply' || x === 'again' || x === 'contact');
  const dateChanged = !!day && !!time && toIso(day, time) !== (a.interview_at ? new Date(Date.parse(a.interview_at)).toISOString() : '');

  return (
    <View style={s.backdrop}>
      <SafeAreaView style={[s.sheet, { backgroundColor: c.card }]} edges={['bottom']}>
        <Pressable onPress={props.onClose} style={s.close} hitSlop={12} accessibilityLabel="✕">
          <Text style={[s.closeText, { color: c.quiet }]}>✕</Text>
        </Pressable>
        <ScrollView style={ui.flex} contentContainerStyle={s.detail} keyboardShouldPersistTaps="handled">
          <Text style={[s.detailTitle, { color: c.ink }]}>{title}</Text>
          {a.vacancy.employer ? <Text style={{ color: c.quiet }}>{a.vacancy.employer}</Text> : null}
          <View style={ui.row}>
            <StageChip stage={a.stage} c={c} lang={lang} />
            {a.method ? <Text style={[s.small, { color: c.quiet }]}>{d.via(d.methods[a.method])}</Text> : null}
          </View>
          <Text style={[s.status, { color: c.quiet }]}>{status(a, lang, now)}</Text>
          {steps.length ? <Button c={c} label={t.next[steps[0]!]} onPress={() => props.onApply(a, steps[0] === 'again')} /> : null}

          {pastInterview || props.focus === 'how' ? (
            <View style={[s.box, { borderColor: c.line }]}>
              <Text style={[s.section, { color: c.ink }]}>{t.how.title}</Text>
              <View style={ui.row}>
                <Button c={c} small label={t.how.offer} busy={busy} onPress={() => save({ stage: 'offer' })} />
                <Button c={c} small ghost label={t.how.wait} onPress={props.onClose} />
                <Button c={c} small ghost label={t.how.reject} onPress={() => save({ stage: 'rejected' })} />
              </View>
            </View>
          ) : null}

          <Text style={[s.section, { color: c.ink }]}>{d.stage}</Text>
          <View style={ui.row}>
            {(a.stage === 'seen' ? (['seen', ...stages] as Stage[]) : stages).map((stage) => (
              <Chip
                key={stage}
                c={c}
                active={a.stage === stage}
                label={t.stages[stage]}
                onPress={() => (stage === a.stage || stage === 'seen' ? undefined : void save({ stage }))}
              />
            ))}
          </View>

          <Text style={[s.section, { color: c.ink }]}>{d.interview}</Text>
          {a.interview_at && !editDate ? (
            <View style={ui.row}>
              <Text style={[s.value, { color: c.ink }]}>📅 {whenRelative(a.interview_at, lang, now)}</Text>
              <Button c={c} small ghost label="✎" onPress={() => setEditDate(true)} />
              {a.vacancy.map ? <Button c={c} small ghost label={t.next.map} onPress={() => openUrl(a.vacancy.map!)} /> : null}
            </View>
          ) : editDate ? (
            <>
              <Text style={[s.small, { color: c.quiet }]}>{d.day}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
                {days(14, lang, now).map((x) => (
                  <Chip key={x.value} c={c} active={day === x.value} label={x.label} onPress={() => setDay(x.value)} />
                ))}
              </ScrollView>
              <Text style={[s.small, { color: c.quiet }]}>{d.time}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
                {TIMES.map((x) => (
                  <Chip key={x} c={c} active={time === x} label={x} onPress={() => setTime(x)} />
                ))}
              </ScrollView>
              <View style={ui.row}>
                <Button
                  c={c}
                  small
                  label={d.save}
                  busy={busy}
                  disabled={!dateChanged}
                  onPress={async () => {
                    if (await save({ interview_at: toIso(day, time) })) setEditDate(false);
                  }}
                />
                {a.interview_at ? (
                  <Button
                    c={c}
                    small
                    ghost
                    label={d.clear}
                    onPress={async () => {
                      if (await save({ interview_at: null })) {
                        setDay('');
                        setTime('');
                        setEditDate(false);
                      }
                    }}
                  />
                ) : null}
              </View>
            </>
          ) : (
            <View style={ui.row}>
              <Button c={c} small ghost label={t.next.setInterview} onPress={() => setEditDate(true)} />
            </View>
          )}

          {a.stage === 'offer' || a.stage === 'hired' || a.start_at || props.focus === 'start' ? (
            <>
              <Text style={[s.section, { color: c.ink }]}>{d.start}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
                {days(14, lang, now).map((x) => (
                  <Chip
                    key={x.value}
                    c={c}
                    active={start === x.value}
                    label={x.label}
                    onPress={() => {
                      setStart(x.value);
                      void save({ start_at: x.value });
                    }}
                  />
                ))}
              </ScrollView>
              {a.start_at ? <Text style={[s.value, { color: c.ink }]}>✓ {dayLabel(a.start_at, lang)}</Text> : null}
            </>
          ) : null}

          <Text style={[s.section, { color: c.ink }]}>{d.note}</Text>
          <Field c={c} value={note} onChangeText={setNote} placeholder={d.notePlaceholder} multiline maxLength={500} />
          {note.trim() !== (a.note ?? '') ? (
            <View style={ui.row}>
              <Button c={c} small label={d.save} busy={busy} onPress={() => void save({ note: note.trim() || null })} />
            </View>
          ) : null}

          {a.link ? (
            <>
              <Text style={[s.section, { color: c.ink }]}>{d.link}</Text>
              <Text selectable style={[s.small, { color: c.accent }]}>
                {a.link.url}
              </Text>
              {a.views ? <Text style={[s.small, { color: c.quiet }]}>👀 {d.views(a.views)}</Text> : null}
            </>
          ) : null}

          {events?.length ? (
            <>
              <Text style={[s.section, { color: c.ink }]}>{d.history}</Text>
              {[...events].reverse().map((e, i) => (
                <Text key={i} style={[s.small, { color: c.quiet }]}>
                  {when(e.at, lang)} · {t.stages[e.stage]} · {d.by[e.by]}
                </Text>
              ))}
            </>
          ) : null}

          <View style={[ui.row, s.links]}>
            {a.vacancy.url ? <Button c={c} small ghost label={d.openVacancy} onPress={() => openUrl(a.vacancy.url!)} /> : null}
            {a.vacancy.source_url && a.vacancy.source_url !== a.vacancy.url ? (
              <Button c={c} small ghost label={d.openPost} onPress={() => openUrl(a.vacancy.source_url!)} />
            ) : null}
          </View>
          <Button c={c} danger label={d.remove} disabled={busy} onPress={remove} />
          {error ? <Text style={[s.error, { color: c.skip }]}>{error}</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  body: { padding: 16, gap: 12, paddingBottom: 32 },
  top: { borderRadius: 16, borderWidth: 1, padding: 14, gap: 8 },
  bar: { flexDirection: 'row', gap: 4 },
  segment: { flex: 1, height: 6, borderRadius: 3 },
  barLabels: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  stageNow: { fontSize: 17, fontWeight: '800' },
  stageNext: { fontSize: 13 },
  week: { fontSize: 15, lineHeight: 21 },
  next: { fontSize: 15, fontWeight: '700', lineHeight: 21 },
  goalRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  goalText: { flex: 1, gap: 3 },
  goalTitle: { fontSize: 16, fontWeight: '700' },
  ringNumber: { fontSize: 18, fontWeight: '800' },
  hint: { fontSize: 13, lineHeight: 18 },
  link: { fontSize: 14, fontWeight: '700', marginTop: 2 },
  flat: { marginTop: 0 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', rowGap: 12 },
  badge: { width: '33.33%', alignItems: 'center', gap: 4, paddingHorizontal: 2 },
  badgeIcon: { width: 46, height: 46, borderRadius: 23, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  badgeEmoji: { fontSize: 22 },
  locked: { opacity: 0.35 },
  badgeText: { fontSize: 12, lineHeight: 15, fontWeight: '600', textAlign: 'center' },
  local: { borderRadius: 16, padding: 14, gap: 8 },
  localTitle: { fontSize: 16, fontWeight: '700' },
  small: { fontSize: 14, lineHeight: 20 },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 48 },
  group: { gap: 8 },
  groupTitle: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 4 },
  row: { padding: 14, borderRadius: 16, borderWidth: 1, gap: 4 },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' },
  rowTitle: { flex: 1, fontSize: 17, fontWeight: '700' },
  chip: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  chipText: { fontSize: 12, fontWeight: '700' },
  status: { fontSize: 14, marginBottom: 4 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    height: '92%',
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: 'hidden',
  },
  close: { position: 'absolute', top: 14, right: 18, zIndex: 2 },
  closeText: { fontSize: 22 },
  detail: { padding: 20, gap: 10, paddingBottom: 40 },
  detailTitle: { fontSize: 22, fontWeight: '800', paddingRight: 28 },
  section: { fontSize: 16, fontWeight: '700', marginTop: 10 },
  value: { fontSize: 16, fontWeight: '600', alignSelf: 'center' },
  box: { borderWidth: 1, borderRadius: 16, padding: 14, gap: 8, marginTop: 6 },
  chips: { gap: 6, paddingVertical: 2 },
  links: { marginTop: 12 },
  error: { fontSize: 14, textAlign: 'center' },
});

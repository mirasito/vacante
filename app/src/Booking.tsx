// Экран «Запись» из макета vacante 2.0: собеседование по отклику. Когда время есть — дата крупно,
// адрес с маршрутом в 2ГИС, что взять, «Перенести» и «Не смогу прийти». Когда времени нет — выбор
// удобного времени (до трёх вариантов, работодатель увидит их кнопками). После собеседования —
// «Я пришёл / Не получилось» и оценка заведения.
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { whenRelative } from './applications/texts';
import { Icon } from './icons';
import { confirm, haptic, openUrl } from './platform';
import { almaty, MONTHS, when } from './profile/texts';
import {
  cancelInterview,
  markAttended,
  putReview,
  putSlots,
  REVIEW_TAGS,
  type Application,
  type Reliability,
  type ReviewTag,
} from './server';
import type { Colors } from './theme';
import type { Lang } from './types';
import { Button, Chip, styles as ui } from './ui';
import { V } from './v2texts';

const HOURS = [10, 12, 15, 18];
const DAYS = 6;
const WEEKDAYS: Record<Lang, string[]> = {
  ru: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
  kk: ['жс', 'дс', 'сс', 'ср', 'бс', 'жм', 'сб'],
};

/** Ближайшие дни с завтрашнего, время Казахстана (UTC+5). */
function days(now: number) {
  return Array.from({ length: DAYS }, (_, i) => {
    const d = almaty(now + (i + 1) * 86_400_000);
    return { ...d, slots: HOURS.map((h) => new Date(Date.UTC(d.year, d.month, d.day, h - 5)).toISOString().replace('.000Z', 'Z')) };
  });
}

/** Адрес в 2ГИС: ссылка из ленты или поиск по адресу. */
export const routeUrl = (a: Application) =>
  a.vacancy.map ?? (a.vacancy.address ? `https://2gis.kz/search/${encodeURIComponent(a.vacancy.address)}` : null);

export function Booking(props: {
  c: Colors;
  lang: Lang;
  app: Application;
  onClose(): void;
  onChange(a: Application, reliability?: Reliability): void;
  onChat(): void;
  /** «Перенести» и «Указать время самому»: карточка отклика с полем даты. */
  onSetTime(): void;
}) {
  const { c, lang, app: a } = props;
  const t = V[lang];
  const now = Date.now();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<string[]>((a.slots ?? []).filter((x) => Date.parse(x) > now));
  const [stars, setStars] = useState(a.review ?? 0);
  const [tags, setTags] = useState<ReviewTag[]>([]);
  const [text, setText] = useState('');
  const title = (lang === 'kk' && a.vacancy.title_kk) || a.vacancy.title;
  const at = a.interview_at ? Date.parse(a.interview_at) : null;
  const past = at !== null && at <= now;
  const route = routeUrl(a);

  const run = async (key: string, fn: () => Promise<void>) => {
    haptic();
    setBusy(key);
    setError('');
    try {
      await fn();
    } catch {
      setError(t.error);
    } finally {
      setBusy('');
    }
  };

  const cancel = async () => {
    if (!(await confirm(t.cantAsk, t.cantYes, t.cantNo))) return;
    await run('cancel', async () => props.onChange((await cancelInterview(a.id, t.cantText)).application));
  };

  const slotsSaved = JSON.stringify(picked) === JSON.stringify((a.slots ?? []).filter((x) => Date.parse(x) > now));

  return (
    <SafeAreaView style={[s.page, { backgroundColor: c.bg }]} edges={['top', 'bottom']}>
      <View style={ui.column}>
        <View style={s.top}>
          <Pressable onPress={props.onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="←" style={s.back}>
            <Icon name="back" color={c.ink} />
          </Pressable>
          <Text style={[s.h1, { color: c.ink }]}>{t.booking}</Text>
        </View>
        <ScrollView contentContainerStyle={s.body}>
          <View style={s.head}>
            <View style={[s.avatar, { backgroundColor: c.strong }]}>
              <Text style={[s.letter, { color: c.onStrong }]}>{(a.vacancy.employer || title).trim().charAt(0).toUpperCase()}</Text>
            </View>
            <View style={ui.flex}>
              <Text style={[s.title, { color: c.ink }]}>{title}</Text>
              {a.vacancy.employer ? <Text style={[s.employer, { color: c.accent }]}>{a.vacancy.employer}</Text> : null}
            </View>
          </View>

          {at !== null ? (
            <View style={[s.card, { backgroundColor: c.strong }]}>
              <Text style={[s.kicker, { color: c.faint }]}>{t.bookingTitle}</Text>
              <Text style={[s.when, { color: c.onStrong }]}>{whenRelative(a.interview_at!, lang, now)}</Text>
              {a.vacancy.address ? <Text style={[s.addr, { color: c.onStrong }]}>{a.vacancy.address}</Text> : null}
            </View>
          ) : (
            <View style={[s.card, { backgroundColor: c.soft }]}>
              <Text style={[s.kicker, { color: c.quiet }]}>{t.bookingTitle}</Text>
              <Text style={[s.whenSmall, { color: c.ink }]}>{t.noTime}</Text>
              {a.cancelled_at ? <Text style={[s.small, { color: c.quiet }]}>{t.cancelled}</Text> : null}
            </View>
          )}

          {at !== null && !past ? (
            <>
              {route ? <Button c={c} ghost icon="map" label={t.route} onPress={() => openUrl(route)} /> : null}
              <View style={s.section}>
                <Text style={[s.h3, { color: c.ink }]}>{t.take}</Text>
                {t.takeList.map((x) => (
                  <View key={x} style={s.take}>
                    <Icon name="shield" color={c.like} size={18} />
                    <Text style={[s.takeText, { color: c.ink }]}>{x}</Text>
                  </View>
                ))}
              </View>
              <View style={ui.row}>
                <Button c={c} ghost icon="calendar" label={t.reschedule} onPress={props.onSetTime} />
                <Button c={c} danger label={t.cantCome} busy={busy === 'cancel'} onPress={cancel} />
              </View>
            </>
          ) : null}

          {at === null ? (
            <View style={s.section}>
              <Text style={[s.h3, { color: c.ink }]}>{t.slotsTitle}</Text>
              <Text style={[s.small, { color: c.quiet }]}>{t.slotsHint}</Text>
              {days(now).map((d) => (
                <View key={`${d.month}-${d.day}`} style={s.dayRow}>
                  <Text style={[s.day, { color: c.ink }]}>
                    {WEEKDAYS[lang][d.weekday]}, {d.day} {MONTHS[lang][d.month]}
                  </Text>
                  <View style={s.times}>
                    {d.slots.map((x, i) => {
                      const on = picked.includes(x);
                      return (
                        <Chip
                          key={x}
                          c={c}
                          active={on}
                          label={`${HOURS[i]}:00`}
                          onPress={() =>
                            setPicked((p) => (on ? p.filter((y) => y !== x) : p.length < 3 ? [...p, x].sort() : p))
                          }
                        />
                      );
                    })}
                  </View>
                </View>
              ))}
              {slotsSaved && picked.length ? (
                <Text style={[s.ok, { color: c.like }]}>✓ {t.slotsSent}</Text>
              ) : (
                <Button
                  c={c}
                  label={t.slotsSave(picked.length)}
                  disabled={!picked.length}
                  busy={busy === 'slots'}
                  onPress={() => run('slots', async () => props.onChange((await putSlots(a.id, picked)).application))}
                />
              )}
              <Button c={c} ghost small icon="calendar" label={t.setTime} onPress={props.onSetTime} />
            </View>
          ) : null}

          {past ? (
            <View style={s.section}>
              <Text style={[s.h3, { color: c.ink }]}>{t.howWent}</Text>
              <Text style={[s.small, { color: c.quiet }]}>{when(a.interview_at!, lang)}</Text>
              {a.attended ? (
                <Text style={[s.ok, { color: a.attended === 'yes' ? c.like : c.hot }]}>
                  {a.attended === 'yes' ? `✓ ${t.cameDone}` : t.missedDone}
                  {a.attended_by === 'employer' ? ` (${t.byEmployer.toLowerCase()})` : ''}
                </Text>
              ) : null}
              {a.attended_by !== 'employer' ? (
                <View style={ui.row}>
                  {(['yes', 'no'] as const).map((v) => (
                    <Button
                      key={v}
                      c={c}
                      ghost={a.attended !== v}
                      label={v === 'yes' ? t.came : t.missed}
                      busy={busy === v}
                      onPress={() =>
                        run(v, async () => {
                          const r = await markAttended(a.id, v);
                          props.onChange(r.application, r.reliability);
                        })
                      }
                    />
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}

          {past && a.vacancy.employer ? (
            <View style={[s.section, s.review, { borderColor: c.line }]}>
              {a.review ? (
                <Text style={[s.ok, { color: c.ink }]}>{t.reviewDone(a.review)}</Text>
              ) : (
                <>
                  <Text style={[s.h3, { color: c.ink }]}>{t.review}</Text>
                  <View style={s.stars}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Pressable key={n} onPress={() => setStars(n)} hitSlop={6} accessibilityRole="button" accessibilityLabel={`${n}`}>
                        <Text style={[s.star, { color: n <= stars ? c.hot : c.line }]}>★</Text>
                      </Pressable>
                    ))}
                  </View>
                  <View style={s.times}>
                    {REVIEW_TAGS.map((tag) => (
                      <Chip
                        key={tag}
                        c={c}
                        active={tags.includes(tag)}
                        label={t.tags[tag]!}
                        onPress={() => setTags((x) => (x.includes(tag) ? x.filter((y) => y !== tag) : [...x, tag]))}
                      />
                    ))}
                  </View>
                  <TextInput
                    value={text}
                    onChangeText={setText}
                    placeholder={t.reviewText}
                    placeholderTextColor={c.faint}
                    multiline
                    maxLength={500}
                    style={[s.input, { color: c.ink, borderColor: c.line, backgroundColor: c.card }]}
                  />
                  <Text style={[s.small, { color: c.quiet }]}>{t.reviewHint}</Text>
                  <Button
                    c={c}
                    label={t.reviewSave}
                    disabled={!stars}
                    busy={busy === 'review'}
                    onPress={() => run('review', async () => props.onChange((await putReview(a.id, { stars, tags, text })).application))}
                  />
                </>
              )}
            </View>
          ) : null}

          {error ? <Text style={[s.small, { color: c.skip }]}>{error}</Text> : null}
          <Button c={c} ghost icon="chat" label={t.write} onPress={props.onChat} />
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  page: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  h1: { fontSize: 22, fontWeight: '800', letterSpacing: -0.4 },
  body: { paddingHorizontal: 20, paddingBottom: 28, gap: 14 },
  head: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  avatar: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  letter: { fontSize: 20, fontWeight: '800' },
  title: { fontSize: 18, fontWeight: '800', lineHeight: 23 },
  employer: { fontSize: 14, fontWeight: '700', marginTop: 2 },
  card: { borderRadius: 18, padding: 18, gap: 4 },
  kicker: { fontSize: 12, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
  when: { fontSize: 26, fontWeight: '800', letterSpacing: -0.4 },
  whenSmall: { fontSize: 18, fontWeight: '800' },
  addr: { fontSize: 15, fontWeight: '600', opacity: 0.9 },
  section: { gap: 10 },
  h3: { fontSize: 16, fontWeight: '800' },
  small: { fontSize: 13, lineHeight: 18 },
  take: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  takeText: { fontSize: 15 },
  dayRow: { gap: 6 },
  day: { fontSize: 14, fontWeight: '700' },
  times: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  ok: { fontSize: 14, fontWeight: '700', lineHeight: 20 },
  review: { borderTopWidth: 1, paddingTop: 14 },
  stars: { flexDirection: 'row', gap: 6 },
  star: { fontSize: 36, lineHeight: 40 },
  input: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, minHeight: 64 },
});

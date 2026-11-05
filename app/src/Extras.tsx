// Мелкие экраны vacante 2.0: тёмная карточка «Надёжность» в профиле и её страница,
// лист «Пригласить друга» и лист «Пожаловаться» на вакансию.
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from './icons';
import { haptic, shareLink, whatsapp } from './platform';
import { getReferral, getReliability, REPORT_REASONS, reportVacancy, type Reliability, type ReportReason } from './server';
import type { Colors } from './theme';
import type { Lang, Vacancy } from './types';
import { Button, IconCircle, Loading, styles as ui } from './ui';
import { V } from './v2texts';

/**
 * «Чаты» и «Профиль» без профиля на сервере: что это и как туда попасть. Вне Telegram — открыть
 * в Telegram (вход без пароля), профили закрыты — объяснить и предложить подписку, профиль можно
 * создать — кнопка «Создать профиль».
 */
export function Locked(props: {
  c: Colors;
  lang: Lang;
  what: 'chats' | 'profile';
  where: 'browser' | 'ready' | 'closed' | 'offline';
  city?: string;
  subscribeUrl: string | null;
  onProfile(): void;
  openUrl(url: string): void;
}) {
  const { c, lang, what, where } = props;
  const t = V[lang].locked;
  const title = what === 'chats' ? t.chatsTitle : t.profileTitle;
  const text = what === 'chats' ? t.chatsText : t.profileText;
  return (
    <ScrollView contentContainerStyle={s.locked}>
      <IconCircle c={c} icon={what === 'chats' ? 'chat' : 'user'} />
      <Text style={[s.lockedTitle, { color: c.ink }]}>{title}</Text>
      <Text style={[s.lockedText, { color: c.quiet }]}>{text}</Text>
      <View style={s.points}>
        {t.points.map((p) => (
          <View key={p} style={s.point}>
            <Text style={[s.pointDot, { color: c.brand }]}>●</Text>
            <Text style={[s.pointText, { color: c.ink }]}>{p}</Text>
          </View>
        ))}
      </View>
      <View style={[s.lockedNote, { backgroundColor: c.soft }]}>
        <Text style={[s.small, { color: c.ink }]}>{t[where]}</Text>
      </View>
      {where === 'browser' ? (
        <Button
          c={c}
          icon="link"
          label={t.openTelegram}
          onPress={() => props.openUrl(`https://t.me/vacantekz_bot?startapp=${props.city ?? 'app'}`)}
        />
      ) : where === 'ready' ? (
        <Button c={c} icon="user" label={t.create} onPress={props.onProfile} />
      ) : props.subscribeUrl ? (
        <Button c={c} icon="bell" label={t.subscribe} onPress={() => props.openUrl(props.subscribeUrl!)} />
      ) : null}
    </ScrollView>
  );
}

const MEDAL: Record<string, string> = { bronze: '🥉', silver: '🥈', gold: '🥇' };

/** Карточка в профиле: уровень, явки и что нужно до следующего уровня. Нажатие — страница с правилами. */
export function ReliabilityCard(props: { c: Colors; lang: Lang; data: Reliability | null; onOpen(): void }) {
  const { c, lang, data } = props;
  const t = V[lang];
  if (!data) return null;
  return (
    <Pressable onPress={props.onOpen} accessibilityRole="button" style={[s.dark, { backgroundColor: c.strong }]}>
      <View style={s.darkHead}>
        <Text style={[s.kicker, { color: c.faint }]}>{t.reliability}</Text>
        <Icon name="next" color={c.faint} size={18} />
      </View>
      <Text style={[s.level, { color: c.onStrong }]}>
        {data.level ? `${MEDAL[data.level]} ${t.level[data.level]}` : t.noLevel}
      </Text>
      <Text style={[s.stats, { color: c.onStrong }]}>{t.stats(data.attended, data.missed, data.cancelled)}</Text>
      {data.next ? (
        <Text style={[s.next, { color: c.faint }]}>{t.next(t.level[data.next.level]!, data.next.need)}</Text>
      ) : (
        <Text style={[s.next, { color: c.faint }]}>{t.top}</Text>
      )}
    </Pressable>
  );
}

export function ReliabilityPage(props: { c: Colors; lang: Lang; onClose(): void }) {
  const { c, lang } = props;
  const t = V[lang];
  const [data, setData] = useState<Reliability | null>(null);
  useEffect(() => {
    getReliability().then(setData, () => undefined);
  }, []);
  return (
    <SafeAreaView style={[s.page, { backgroundColor: c.bg }]} edges={['top', 'bottom']}>
      <View style={ui.column}>
        <View style={s.top}>
          <Pressable onPress={props.onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="←" style={s.back}>
            <Icon name="back" color={c.ink} />
          </Pressable>
          <Text style={[s.h1, { color: c.ink }]}>{t.reliability}</Text>
        </View>
        <ScrollView contentContainerStyle={s.body}>
          {data ? <ReliabilityCard c={c} lang={lang} data={data} onOpen={() => undefined} /> : <Loading c={c} text="" />}
          <Text style={[s.h3, { color: c.ink }]}>{t.levels}</Text>
          {t.levelRules.map(([name, rule], i) => {
            const key = (['bronze', 'silver', 'gold'] as const)[i]!;
            const on = data?.level === key;
            return (
              <View key={name} style={[s.rule, { borderColor: on ? c.accent : c.line, backgroundColor: c.card }]}>
                <Text style={s.medal}>{MEDAL[key]}</Text>
                <View style={ui.flex}>
                  <Text style={[s.ruleName, { color: c.ink }]}>{name}</Text>
                  <Text style={[s.small, { color: c.quiet }]}>{rule}</Text>
                </View>
              </View>
            );
          })}
          <Text style={[s.small, { color: c.quiet }]}>{t.levelNote}</Text>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

/** Лист снизу: тёмный фон, карточка с заголовком и крестиком. */
function Sheet(props: { c: Colors; title: string; onClose(): void; children: React.ReactNode }) {
  const { c } = props;
  return (
    <View style={s.backdrop}>
      <Pressable style={ui.flex} onPress={props.onClose} accessibilityLabel="✕" />
      <SafeAreaView edges={['bottom']} style={[s.sheet, { backgroundColor: c.card }]}>
        <View style={[s.grab, { backgroundColor: c.line }]} />
        <View style={s.sheetHead}>
          <Text style={[s.h2, { color: c.ink }]}>{props.title}</Text>
          <Pressable onPress={props.onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="✕">
            <Icon name="close" color={c.quiet} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={s.sheetBody}>{props.children}</ScrollView>
      </SafeAreaView>
    </View>
  );
}

export function InviteSheet(props: { c: Colors; lang: Lang; onClose(): void }) {
  const { c, lang } = props;
  const t = V[lang];
  const [ref, setRef] = useState<{ url: string; invited: number } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    getReferral().then(setRef, () => setFailed(true));
  }, []);
  return (
    <Sheet c={c} title={t.invite} onClose={props.onClose}>
      <Text style={[s.text, { color: c.ink }]}>{t.inviteText}</Text>
      {ref ? (
        <>
          <View style={[s.link, { backgroundColor: c.soft }]}>
            <Text style={[s.linkText, { color: c.ink }]} selectable>
              {ref.url}
            </Text>
          </View>
          <Button c={c} icon="share" label={t.inviteShare} onPress={() => shareLink(t.inviteMessage, ref.url)} />
          <Button c={c} ghost icon="chat" label={t.inviteWa} onPress={() => whatsapp(t.inviteMessage, ref.url)} />
          <Text style={[s.small, { color: c.quiet, textAlign: 'center' }]}>{t.inviteCount(ref.invited)}</Text>
        </>
      ) : failed ? (
        <Text style={[s.small, { color: c.skip }]}>{t.error}</Text>
      ) : (
        <Loading c={c} text="" />
      )}
    </Sheet>
  );
}

export function ReportSheet(props: { c: Colors; lang: Lang; v: Vacancy; onClose(): void; onSent(): void }) {
  const { c, lang, v } = props;
  const t = V[lang];
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const send = async () => {
    if (!reason) return;
    haptic();
    setBusy(true);
    setError('');
    try {
      await reportVacancy({ vacancy_id: v.id, title: v.title, employer: v.employer ?? null, url: v.url, reason, text });
      setDone(true);
      props.onSent();
    } catch {
      setError(t.error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet c={c} title={done ? t.report : t.reportTitle} onClose={props.onClose}>
      {done ? (
        <>
          <Text style={[s.text, { color: c.ink }]}>✓ {t.reportDone}</Text>
          <Button c={c} label="OK" onPress={props.onClose} />
        </>
      ) : (
        <>
          {REPORT_REASONS.map((r) => (
            <Pressable
              key={r}
              onPress={() => setReason(r)}
              accessibilityRole="radio"
              accessibilityState={{ checked: reason === r }}
              style={[s.reason, { borderColor: reason === r ? c.accent : c.line }]}
            >
              <View style={[s.radio, { borderColor: reason === r ? c.accent : c.faint }]}>
                {reason === r ? <View style={[s.dot, { backgroundColor: c.accent }]} /> : null}
              </View>
              <Text style={[s.reasonText, { color: c.ink }]}>{t.reasons[r]}</Text>
            </Pressable>
          ))}
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={t.reportText}
            placeholderTextColor={c.faint}
            multiline
            maxLength={500}
            style={[s.input, { color: c.ink, borderColor: c.line }]}
          />
          {error ? <Text style={[s.small, { color: c.skip }]}>{error}</Text> : null}
          <Button c={c} label={t.reportSend} disabled={!reason} busy={busy} onPress={send} />
        </>
      )}
    </Sheet>
  );
}

const s = StyleSheet.create({
  locked: { padding: 24, gap: 14, alignItems: 'stretch', maxWidth: 520, width: '100%', alignSelf: 'center' },
  lockedTitle: { fontSize: 22, fontWeight: '800', letterSpacing: -0.3, textAlign: 'center' },
  lockedText: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  points: { gap: 8 },
  point: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  pointDot: { fontSize: 10, lineHeight: 21 },
  pointText: { flex: 1, fontSize: 15, lineHeight: 21, fontWeight: '600' },
  lockedNote: { borderRadius: 14, padding: 14 },
  page: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  h1: { fontSize: 22, fontWeight: '800', letterSpacing: -0.4 },
  h2: { fontSize: 20, fontWeight: '800', letterSpacing: -0.3, flexShrink: 1 },
  h3: { fontSize: 16, fontWeight: '800', marginTop: 6 },
  body: { paddingHorizontal: 20, paddingBottom: 28, gap: 12 },
  dark: { borderRadius: 18, padding: 18, gap: 6 },
  darkHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  kicker: { fontSize: 12, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
  level: { fontSize: 24, fontWeight: '800', letterSpacing: -0.3 },
  stats: { fontSize: 14, fontWeight: '600' },
  next: { fontSize: 13, lineHeight: 18 },
  rule: { flexDirection: 'row', gap: 12, alignItems: 'center', borderWidth: 1, borderRadius: 14, padding: 14 },
  medal: { fontSize: 26 },
  ruleName: { fontSize: 15, fontWeight: '700' },
  small: { fontSize: 13, lineHeight: 18 },
  text: { fontSize: 15, lineHeight: 21 },
  backdrop: { flex: 1, backgroundColor: 'rgba(20,20,19,0.5)', justifyContent: 'flex-end' },
  sheet: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '90%',
    alignSelf: 'center',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 10,
  },
  grab: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 6 },
  sheetHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 6 },
  sheetBody: { paddingHorizontal: 20, paddingBottom: 20, gap: 10 },
  link: { borderRadius: 12, padding: 12 },
  linkText: { fontSize: 14, fontWeight: '600' },
  reason: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 14, padding: 14 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  reasonText: { flex: 1, fontSize: 15, fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, minHeight: 64 },
});

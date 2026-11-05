// Вкладка «Чаты» из макета vacante 2.0: переписка с работодателями по откликам. Соискатель пишет
// здесь, работодатель видит сообщения на странице профиля по ссылке отклика и отвечает там же,
// а ответ приходит сюда и в бот.
import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import * as i18n from './i18n';
import { Icon } from './icons';
import { haptic, onAppVisible } from './platform';
import { when } from './profile/texts';
import { ApiError, getMessages, listChats, sendMessage, type Application, type Chat, type ChatMessage } from './server';
import type { Colors } from './theme';
import type { Lang } from './types';
import { IconCircle, Loading, Retry, styles as ui } from './ui';
import { V } from './v2texts';

const title = (a: Application, lang: Lang) => (lang === 'kk' && a.vacancy.title_kk) || a.vacancy.title;

export function ChatsTab(props: {
  c: Colors;
  lang: Lang;
  /** Открыть переписку по отклику: из сообщения бота или кнопкой «Написать работодателю». */
  open: number | null;
  onOpen(id: number | null): void;
  /** Сколько непрочитанных: для значка на вкладке. */
  onUnread(n: number): void;
}) {
  const { c, lang, open, onOpen, onUnread } = props;
  const t = V[lang];
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    listChats().then(
      (r) => {
        if (!alive) return;
        setChats(r.chats);
        onUnread(r.unread);
      },
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [attempt, open, onUnread]);
  useEffect(() => onAppVisible(() => setAttempt((n) => n + 1)), []);

  if (open) return <ChatView c={c} lang={lang} id={open} onBack={() => onOpen(null)} />;
  if (failed && !chats) return <Retry c={c} lang={lang} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!chats) return <Loading c={c} text="" />;
  if (!chats.length) {
    return (
      <View style={ui.center}>
        <IconCircle c={c} icon="chat" />
        <Text style={[ui.h2, { color: c.ink }]}>{t.chats}</Text>
        <Text style={[ui.note, { color: c.quiet }]}>{t.chatsEmpty}</Text>
      </View>
    );
  }
  return (
    <FlatList
      data={chats}
      keyExtractor={(x) => String(x.application.id)}
      ListHeaderComponent={<Text style={[ui.h1, s.title, { color: c.ink }]}>{t.chats}</Text>}
      contentContainerStyle={s.list}
      renderItem={({ item: { application: a, last } }) => (
        <Pressable
          onPress={() => {
            haptic();
            onOpen(a.id);
          }}
          accessibilityRole="button"
          style={[s.row, { borderColor: c.line }]}
        >
          <View style={[s.avatar, { backgroundColor: c.strong }]}>
            <Text style={[s.letter, { color: c.onStrong }]}>{(a.vacancy.employer || a.vacancy.title).trim().charAt(0).toUpperCase()}</Text>
          </View>
          <View style={ui.flex}>
            <View style={s.rowHead}>
              <Text style={[s.name, { color: c.ink }]} numberOfLines={1}>
                {a.vacancy.employer || title(a, lang)}
              </Text>
              {last ? <Text style={[s.time, { color: c.faint }]}>{i18n.age(last.at, lang)}</Text> : null}
            </View>
            <Text style={[s.sub, { color: c.quiet }]} numberOfLines={1}>
              {title(a, lang)}
            </Text>
            <Text style={[s.last, { color: a.unread ? c.ink : c.quiet }, a.unread ? s.bold : null]} numberOfLines={1}>
              {last ? `${last.by === 'seeker' ? `${t.you}: ` : ''}${last.text}` : t.chatEmpty}
            </Text>
          </View>
          {a.unread ? (
            <View style={[s.unread, { backgroundColor: c.accent }]}>
              <Text style={s.unreadText}>{a.unread}</Text>
            </View>
          ) : null}
        </Pressable>
      )}
    />
  );
}

/** Одна переписка: сообщения пузырями и поле ввода. Пока открыта, раз в 20 секунд проверяет ответ. */
export function ChatView(props: { c: Colors; lang: Lang; id: number; onBack(): void }) {
  const { c, lang, id } = props;
  const t = V[lang];
  const [app, setApp] = useState<Application | null>(null);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const list = useRef<ComponentRef<typeof ScrollView>>(null);

  const load = useCallback(() => {
    getMessages(id).then(
      (r) => {
        setMessages(r.messages);
        setApp(r.application);
      },
      () => setMessages((m) => m ?? []),
    );
  }, [id]);
  useEffect(() => {
    load();
    const timer = setInterval(load, 20_000);
    const off = onAppVisible(load);
    return () => {
      clearInterval(timer);
      off();
    };
  }, [load]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    haptic();
    setBusy(true);
    setError('');
    try {
      const r = await sendMessage(id, body);
      setMessages((m) => [...(m ?? []), r.message]);
      setText('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? t.wait : t.sendError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={ui.flex}>
      <View style={[s.top, { borderColor: c.line }]}>
        <Pressable onPress={props.onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel={i18n.t(lang, 'back')} style={s.back}>
          <Icon name="back" color={c.ink} />
        </Pressable>
        <View style={ui.flex}>
          <Text style={[s.name, { color: c.ink }]} numberOfLines={1}>
            {app ? app.vacancy.employer || title(app, lang) : ' '}
          </Text>
          {app ? (
            <Text style={[s.sub, { color: c.quiet }]} numberOfLines={1}>
              {title(app, lang)}
            </Text>
          ) : null}
        </View>
      </View>
      {!messages ? (
        <Loading c={c} text="" />
      ) : (
        <ScrollView
          ref={list}
          style={ui.flex}
          contentContainerStyle={s.messages}
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        >
          {!messages.length ? (
            <View style={[s.note, { backgroundColor: c.soft }]}>
              <Icon name="chat" color={c.quiet} size={20} />
              <Text style={[s.noteText, { color: c.quiet }]}>{t.chatEmpty}</Text>
            </View>
          ) : null}
          {messages.map((m) => {
            const mine = m.by === 'seeker';
            return (
              <View key={m.id} style={[s.bubble, mine ? s.mine : s.theirs, { backgroundColor: mine ? c.accent : c.pill }]}>
                <Text style={[s.bubbleText, { color: mine ? '#fff' : c.ink }]}>{m.text}</Text>
                <Text style={[s.bubbleTime, { color: mine ? 'rgba(255,255,255,0.75)' : c.quiet }]}>
                  {when(m.at, lang)}
                  {mine && m.read_at ? ' · ✓✓' : ''}
                </Text>
              </View>
            );
          })}
        </ScrollView>
      )}
      {error ? <Text style={[s.error, { color: c.skip }]}>{error}</Text> : null}
      <View style={[s.compose, { borderColor: c.line, backgroundColor: c.card }]}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={t.placeholder}
          placeholderTextColor={c.faint}
          multiline
          maxLength={1000}
          style={[s.input, { color: c.ink, backgroundColor: c.soft }]}
          accessibilityLabel={t.placeholder}
        />
        <Pressable
          onPress={send}
          disabled={!text.trim() || busy}
          accessibilityRole="button"
          accessibilityLabel={t.send}
          style={[s.send, { backgroundColor: c.accent }, (!text.trim() || busy) && ui.disabled]}
        >
          <Icon name="next" color="#fff" size={22} />
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  title: { paddingHorizontal: 0, marginTop: 4 },
  list: { paddingHorizontal: 20, paddingBottom: 24 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1 },
  avatar: { width: 44, height: 44, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  letter: { fontSize: 18, fontWeight: '800' },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  name: { fontSize: 15, fontWeight: '700', flexShrink: 1 },
  time: { fontSize: 12 },
  sub: { fontSize: 13, marginTop: 1 },
  last: { fontSize: 14, marginTop: 2 },
  bold: { fontWeight: '700' },
  unread: { minWidth: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  unreadText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1 },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  messages: { padding: 16, gap: 8 },
  note: { flexDirection: 'row', gap: 10, borderRadius: 14, padding: 14, alignItems: 'flex-start' },
  noteText: { flex: 1, fontSize: 13, lineHeight: 18 },
  bubble: { maxWidth: '85%', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  mine: { alignSelf: 'flex-end', borderBottomRightRadius: 4 },
  theirs: { alignSelf: 'flex-start', borderBottomLeftRadius: 4 },
  bubbleText: { fontSize: 15, lineHeight: 20 },
  bubbleTime: { fontSize: 11, marginTop: 2, alignSelf: 'flex-end' },
  error: { fontSize: 13, paddingHorizontal: 16, paddingBottom: 4 },
  compose: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, borderTopWidth: 1 },
  input: { flex: 1, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, maxHeight: 120, minHeight: 40 },
  send: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});

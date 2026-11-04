// Окно «Как откликнуться?»: готовый текст, ссылка на профиль и способы отклика по виду вакансии.
// Отправляет всегда сам человек, со своего WhatsApp или Telegram. Номер из поста сервер отдаёт
// только в момент отклика и не хранит, поэтому сначала его ищем, а открываем WhatsApp вторым нажатием:
// Telegram открывает ссылки только в ответ на нажатие.
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { copyText, haptic, openUrl, openWhatsapp } from '../platform';
import { phoneLabel } from '../profile/texts';
import {
  ApiError,
  lookupContact,
  startApplication,
  type Application,
  type Message,
  type Method,
  type PostContact,
  type VacancyCopy,
} from '../server';
import type { Colors } from '../theme';
import type { Lang } from '../types';
import { Button, Check, styles as ui } from '../ui';
import { methodsFor, needsContact, sourceOf } from './model';
import { A } from './texts';

type Step = 'choose' | 'contact' | 'confirm' | 'done';

/**
 * Готовый текст вместо отклика: «Написать ещё раз» или «Опаздываю» из напоминания.
 * Отклик уже есть, поэтому после того, как человек открыл чат, окно просто закрывается.
 */
export interface Preset {
  kicker: string;
  text: string;
  /** Добавить строку со ссылкой на профиль. */
  link: boolean;
}

export function ApplySheet(props: {
  c: Colors;
  lang: Lang;
  vacancy: VacancyCopy;
  /** Есть профиль: отклик живёт на сервере, у него своя ссылка и готовый текст. */
  server: boolean;
  /** Имя из Telegram для короткого текста без профиля. */
  name: string;
  onStarted(app: Application): void;
  /** «Да, отправлено». app — отклик на сервере, null — отклик только на телефоне. */
  onSent(method: Method, app: Application | null): Promise<void>;
  onClose(): void;
  onMakeProfile(): void;
  onOpenTracker(): void;
  preset?: Preset;
  /** С готовым текстом: человек открыл чат с работодателем. */
  onDone?(): void;
}) {
  const { c, lang, vacancy, server, preset } = props;
  const t = A[lang];
  const title = (lang === 'kk' && vacancy.title_kk) || vacancy.title;
  const short = preset?.text ?? t.shortText(title, props.name);
  const [app, setApp] = useState<Application | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [loading, setLoading] = useState(server);
  const [text, setText] = useState(server ? '' : short);
  const [withLink, setWithLink] = useState(preset?.link ?? true);
  const [step, setStep] = useState<Step>('choose');
  const [method, setMethod] = useState<Method | null>(null);
  const [contact, setContact] = useState<PostContact | null>(null);
  const [searching, setSearching] = useState(false);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const started = useRef(props.onStarted);

  // С профилем: отклик со стадией «Нравится», его ссылка и готовый текст с сервера
  useEffect(() => {
    if (!server) return;
    let alive = true;
    startApplication(vacancy, lang).then(
      (r) => {
        if (!alive) return;
        setApp(r.application);
        setMessage(r.message);
        setText(preset?.text ?? r.message?.text ?? short);
        setLoading(false);
        started.current(r.application);
      },
      () => {
        if (!alive) return;
        setText(short);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
    // Отклик заводим один раз на открытие окна
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const full = () => (message && withLink ? `${text.trim()}\n${message.link_text}` : text.trim());
  const postUrl = vacancy.source_url ?? vacancy.url ?? '';
  const methods = methodsFor(vacancy);
  const other = sourceOf(vacancy.source_url) === 'other';

  const opened = (m: Method) => {
    if (preset) {
      props.onDone?.();
      props.onClose();
      return;
    }
    setMethod(m);
    setStep('confirm');
  };

  const choose = (m: Method) => {
    haptic();
    setNotice('');
    if (needsContact(m)) {
      setMethod(m);
      setStep('contact');
      if (contact || searching) return;
      setSearching(true);
      lookupContact(vacancy.id, vacancy.source_url ?? '').then(
        (found) => {
          setContact(found);
          setSearching(false);
          if (!found.whatsapp && !found.phone && !found.telegram) setNotice(t.noContact);
        },
        (err) => {
          setSearching(false);
          setNotice(err instanceof ApiError && err.status === 429 ? t.limit : t.failed);
        },
      );
      return;
    }
    // hh.kz: ссылку на профиль кладём в буфер, чтобы вставить в сопроводительное письмо
    if (m === 'hh' && message && withLink && app?.link && copyText(app.link.url)) setNotice(t.linkCopied);
    openUrl(postUrl);
    opened(m);
  };

  const toWhatsapp = () => {
    if (!contact?.whatsapp) return;
    haptic();
    openWhatsapp(full(), contact.whatsapp);
    opened('whatsapp');
  };

  const toPhone = () => {
    if (!contact?.phone) return;
    haptic();
    openUrl(`tel:${contact.phone}`);
    opened('call');
  };

  const toTelegram = () => {
    if (!contact?.telegram) return;
    haptic();
    setNotice(copyText(full()) ? t.copied : '');
    openUrl(`https://t.me/${contact.telegram}`);
    opened('telegram');
  };

  const confirmSent = async () => {
    if (!method) return;
    setSaving(true);
    setNotice('');
    try {
      await props.onSent(method, app);
      setStep('done');
    } catch {
      setNotice(t.saveError);
    } finally {
      setSaving(false);
    }
  };

  const back = () => {
    setNotice('');
    setStep(contact && method && needsContact(method) ? 'contact' : 'choose');
  };

  return (
    <View style={s.backdrop}>
      <SafeAreaView style={[s.sheet, { backgroundColor: c.card }]} edges={['bottom']}>
        <Pressable onPress={props.onClose} style={s.close} hitSlop={12} accessibilityLabel="✕">
          <Text style={[s.closeText, { color: c.quiet }]}>✕</Text>
        </Pressable>
        <ScrollView style={s.scroll} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <Text style={[s.kicker, { color: c.quiet }]}>{preset?.kicker ?? t.sheetTitle}</Text>
          <Text style={[s.title, { color: c.ink }]}>{title}</Text>
          {vacancy.employer ? <Text style={[s.employer, { color: c.quiet }]}>{vacancy.employer}</Text> : null}

          {step === 'choose' ? (
            <>
              {!server ? (
                <View style={[s.card, { backgroundColor: c.pill }]}>
                  <Text style={[s.cardTitle, { color: c.ink }]}>🎥 {t.noProfileTitle}</Text>
                  <Text style={[s.small, { color: c.ink }]}>{t.noProfileText}</Text>
                  <View style={ui.row}>
                    <Button c={c} small label={t.makeProfile} onPress={props.onMakeProfile} />
                  </View>
                </View>
              ) : null}
              <Text style={[s.label, { color: c.ink }]}>{t.message}</Text>
              {loading ? (
                <View style={[s.input, s.loading, { borderColor: c.line }]}>
                  <ActivityIndicator color={c.accent} />
                  <Text style={{ color: c.quiet }}>{t.preparing}</Text>
                </View>
              ) : (
                <TextInput
                  value={text}
                  onChangeText={setText}
                  multiline
                  maxLength={1000}
                  style={[s.input, { color: c.ink, borderColor: c.line, backgroundColor: c.bg }]}
                  accessibilityLabel={t.message}
                />
              )}
              <Text style={[s.hint, { color: c.quiet }]}>{t.messageHint}</Text>
              {message && app?.link ? (
                <Check
                  c={c}
                  checked={withLink}
                  label={t.withLink}
                  hint={`${t.withLinkHint}\n${app.link.url}`}
                  onPress={() => setWithLink((v) => !v)}
                />
              ) : null}
              <View style={s.buttons}>
                {methods.map((m, i) => (
                  <Button
                    key={m}
                    c={c}
                    ghost={i > 0}
                    label={m === 'post' && other ? t.site : t.methods[m]}
                    disabled={loading || (needsContact(m) && !vacancy.source_url)}
                    onPress={() => choose(m)}
                  />
                ))}
                <Button c={c} ghost small label={t.later} onPress={props.onClose} />
              </View>
            </>
          ) : step === 'contact' ? (
            <>
              {searching ? (
                <View style={s.searching}>
                  <ActivityIndicator color={c.accent} />
                  <Text style={{ color: c.quiet }}>{t.searching}</Text>
                </View>
              ) : contact && (contact.whatsapp || contact.phone || contact.telegram) ? (
                <>
                  <Text style={[s.label, { color: c.ink }]}>{t.foundTitle}</Text>
                  {contact.phone ? (
                    <Text selectable style={[s.phone, { color: c.ink }]}>
                      {phoneLabel(contact.phone)}
                    </Text>
                  ) : null}
                  {contact.telegram ? (
                    <Text selectable style={[s.handle, { color: c.ink }]}>
                      @{contact.telegram}
                    </Text>
                  ) : null}
                  <View style={s.buttons}>
                    {contact.whatsapp ? <Button c={c} label={t.openWhatsapp} onPress={toWhatsapp} /> : null}
                    {contact.phone ? (
                      <Button c={c} ghost={!!contact.whatsapp} label={t.callNow} onPress={toPhone} />
                    ) : null}
                    {contact.telegram ? (
                      <Button
                        c={c}
                        ghost={!!(contact.whatsapp || contact.phone)}
                        label={t.openChat(contact.telegram)}
                        onPress={toTelegram}
                      />
                    ) : null}
                    {contact.phone ? (
                      <Button
                        c={c}
                        ghost
                        small
                        label={t.copyNumber}
                        onPress={() => setNotice(copyText(contact.phone!) ? t.numberCopied : '')}
                      />
                    ) : null}
                  </View>
                  <Text style={[s.hint, { color: c.quiet }]}>{t.foundNote}</Text>
                </>
              ) : (
                <View style={s.buttons}>
                  <Button c={c} label={t.methods.post} onPress={() => choose('post')} />
                </View>
              )}
              <View style={ui.row}>
                <Button c={c} ghost small label={t.back} onPress={() => (setNotice(''), setStep('choose'))} />
              </View>
            </>
          ) : step === 'confirm' && method ? (
            <>
              <Text style={[s.question, { color: c.ink }]}>{t.confirm[method]}</Text>
              <Text style={[s.small, { color: c.quiet }]}>{t.confirmText}</Text>
              {method === 'call' && contact?.phone ? (
                <Text selectable style={[s.phone, { color: c.ink }]}>
                  {phoneLabel(contact.phone)}
                </Text>
              ) : null}
              <View style={s.buttons}>
                <Button c={c} label={t.yes} busy={saving} onPress={confirmSent} />
                <Button c={c} ghost label={t.no} onPress={back} />
              </View>
            </>
          ) : (
            <View style={s.done}>
              <Text style={ui.big}>✅</Text>
              <Text style={[s.question, { color: c.ink, textAlign: 'center' }]}>{t.doneTitle}</Text>
              <Text style={[s.small, { color: c.quiet, textAlign: 'center' }]}>
                {!app ? t.doneLocal : withLink && message ? t.doneLink : t.doneNoLink}
              </Text>
              <View style={[s.buttons, s.wide]}>
                <Button c={c} label={t.ok} onPress={props.onClose} />
                <Button c={c} ghost label={t.openTracker} onPress={props.onOpenTracker} />
              </View>
            </View>
          )}

          {notice ? <Text style={[s.notice, { color: c.ink, backgroundColor: c.pill }]}>{notice}</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  // Окно по высоте содержимого, длинное прокручивается
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
  body: { padding: 20, paddingTop: 18, gap: 10 },
  kicker: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  title: { fontSize: 22, fontWeight: '800', paddingRight: 28 },
  employer: { fontSize: 15, marginTop: -6 },
  card: { borderRadius: 16, padding: 14, gap: 8 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  label: { fontSize: 15, fontWeight: '700', marginTop: 6 },
  input: { borderWidth: 1, borderRadius: 14, padding: 12, fontSize: 16, lineHeight: 22, minHeight: 130, textAlignVertical: 'top' },
  loading: { alignItems: 'center', justifyContent: 'center', gap: 8 },
  hint: { fontSize: 13, lineHeight: 18 },
  small: { fontSize: 14, lineHeight: 20 },
  buttons: { gap: 8, marginTop: 6 },
  searching: { alignItems: 'center', gap: 10, paddingVertical: 24 },
  phone: { fontSize: 26, fontWeight: '800', letterSpacing: 0.3 },
  handle: { fontSize: 20, fontWeight: '700' },
  question: { fontSize: 20, fontWeight: '800', marginTop: 8 },
  done: { alignItems: 'center', gap: 10, paddingVertical: 12 },
  wide: { alignSelf: 'stretch' },
  notice: { borderRadius: 12, padding: 12, fontSize: 14, lineHeight: 20, overflow: 'hidden' },
});

// «Где вы живёте?»: точка по телефону («Я дома») или дом по ссылке из 2ГИС. Нужна, чтобы
// показывать, далеко ли ехать до работы. Сервер хранит точку округлённой до 300–500 метров,
// адрес не хранит, а работодатель её не видит.
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { haptic, openLocationSettings, openUrl, phoneLocation } from '../platform';
import { ApiError, homeFromLink, type Home } from '../server';
import type { Colors } from '../theme';
import type { Lang } from '../types';
import { Button, Field } from '../ui';
import { P } from './texts';

/** Казахстан с запасом, как на сервере (server/src/geo.ts). */
const inKazakhstan = (lat: number, lon: number) => lat >= 40.5 && lat <= 55.5 && lon >= 46.4 && lon <= 87.4;

const LINK = /https?:\/\/\S*2gis\.(?:kz|ru|com)\/\S+/i;

export interface HomeDraft {
  home: Home | null;
  /** Подпись 2ГИС («Жилой дом, Абая проспект, 150»): только показать человеку, не сохраняется. */
  label: string;
}

export function HomeStep(props: { c: Colors; lang: Lang; value: HomeDraft; onChange(v: HomeDraft): void }) {
  const { c, lang, value, onChange } = props;
  const t = P[lang];
  const [busy, setBusy] = useState<'phone' | 'link' | null>(null);
  const [link, setLink] = useState('');
  const [note, setNote] = useState('');
  const [denied, setDenied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const asked = useRef('');

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const byPhone = async () => {
    haptic();
    setBusy('phone');
    setNote('');
    const at = await phoneLocation();
    setBusy(null);
    if (at === 'denied') {
      setDenied(true);
      setNote(t.homeDenied);
    } else if (at === 'unavailable') {
      setNote(t.homeNoGps);
    } else if (!inKazakhstan(at.lat, at.lon)) {
      setNote(t.homeNotKz);
    } else {
      haptic('medium');
      setDenied(false);
      onChange({ home: { lat: at.lat, lon: at.lon, source: 'phone' }, label: t.homeByPhone });
    }
  };

  const find = async (text: string) => {
    if (asked.current === text) return;
    asked.current = text;
    setBusy('link');
    setNote('');
    try {
      const found = await homeFromLink(text);
      haptic('medium');
      onChange({ home: { lat: found.lat, lon: found.lon, source: '2gis' }, label: found.label ?? t.home2gis });
      setLink('');
    } catch (err) {
      asked.current = '';
      const status = err instanceof ApiError ? err.status : 0;
      setNote(status === 422 ? t.homeNotFound : status === 400 ? t.homeBadLink : t.homeLinkError);
    } finally {
      setBusy(null);
    }
  };

  // Ссылку обычно вставляют целиком: ищем дом, когда текст перестал меняться
  const typed = (text: string) => {
    setLink(text);
    setNote('');
    if (timer.current) clearTimeout(timer.current);
    if (LINK.test(text)) timer.current = setTimeout(() => find(text), 500);
  };

  const label = value.label || (value.home?.source === '2gis' ? t.home2gis : t.homeByPhone);
  return (
    <>
      <Text style={[s.title, { color: c.ink }]}>{t.homeTitle}</Text>
      <Text style={[s.hint, { color: c.quiet }]}>{t.homeHint}</Text>
      {value.home ? (
        <View style={[s.done, { backgroundColor: c.pill }]}>
          <Text style={[s.doneText, { color: c.ink }]}>✓ {t.homeSet(label)}</Text>
          <Pressable onPress={() => onChange({ home: null, label: '' })} hitSlop={8}>
            <Text style={[s.link, { color: c.skip }]}>{t.homeClear}</Text>
          </Pressable>
        </View>
      ) : null}
      <Button
        c={c}
        ghost={!!value.home}
        label={busy === 'phone' ? t.homeLocating : t.homePhone}
        busy={busy === 'phone'}
        disabled={busy === 'link'}
        onPress={byPhone}
      />
      {denied ? (
        <Pressable onPress={() => openLocationSettings()} hitSlop={8}>
          <Text style={[s.link, { color: c.accent }]}>{t.homeSettings}</Text>
        </Pressable>
      ) : null}
      <Text style={[s.or, { color: c.quiet }]}>{t.homeOr}</Text>
      <Field
        c={c}
        label={t.homeLink}
        placeholder="https://go.2gis.com/…"
        value={link}
        onChangeText={typed}
        onSubmitEditing={() => LINK.test(link) && find(link)}
        autoCapitalize="none"
        autoCorrect={false}
        inputMode="url"
        maxLength={2000}
      />
      <Text style={[s.small, { color: c.quiet }]}>{busy === 'link' ? t.homeFinding : t.homeLinkHint}</Text>
      <Pressable onPress={() => openUrl('https://2gis.kz/')} hitSlop={8}>
        <Text style={[s.link, { color: c.accent }]}>{t.homeOpen2gis}</Text>
      </Pressable>
      {note ? <Text style={[s.note, { color: c.skip }]}>{note}</Text> : null}
    </>
  );
}

const s = StyleSheet.create({
  title: { fontSize: 24, fontWeight: '800', lineHeight: 30 },
  hint: { fontSize: 14, lineHeight: 20, marginTop: -8 },
  done: { borderRadius: 14, padding: 12, gap: 6, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' },
  doneText: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  or: { fontSize: 14, textAlign: 'center' },
  small: { fontSize: 13, lineHeight: 18 },
  link: { fontSize: 15, fontWeight: '600' },
  note: { fontSize: 15, lineHeight: 21 },
});

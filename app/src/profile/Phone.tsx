// Шаг «Телефон»: номер обязателен с 2026-11-17. В Telegram — одна кнопка «Поделиться номером»,
// на сайте и в других местах — просто поле ввода. Номер видит только работодатель, нажавший «Показать телефон».
import { useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { canRequestContact, haptic, requestContactPhone } from '../platform';
import { askPhone, cancelPhone, pendingPhone } from '../server';
import type { Colors } from '../theme';
import type { Lang } from '../types';
import { Button, Field } from '../ui';
import { P, phoneLabel } from './texts';

/** Номер Казахстана в виде +77XXXXXXXXX или null (те же правила, что normalizePhone на сервере). */
export function kzPhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith('7')) digits = `7${digits}`;
  return /^77\d{9}$/.test(digits) ? `+${digits}` : null;
}

/** Запасной путь: Telegram отдал номер только боту, бот положил его на сервер. Ждём несколько секунд. */
async function phoneFromBot(): Promise<string | null> {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const { phone } = await pendingPhone().catch(() => ({ phone: null }));
    if (phone) return phone;
  }
  return null;
}

/** Номер одной кнопкой Telegram: из ответа окна, иначе через бота. null — не вышло. */
export async function shareTelegramPhone(): Promise<string | null> {
  await askPhone().catch(() => undefined);
  const { shared, phone } = await requestContactPhone();
  if (phone) {
    cancelPhone().catch(() => undefined);
    return kzPhone(phone) ?? phone;
  }
  if (!shared) {
    cancelPhone().catch(() => undefined);
    return null;
  }
  return phoneFromBot();
}

export function PhoneStep(props: {
  c: Colors;
  lang: Lang;
  value: string;
  onChange(phone: string): void;
  /** Номер пришёл из Telegram: анкета идёт дальше сама. */
  onShared?(phone: string): void;
  title?: string;
  hint?: string;
}) {
  const { c, lang, value, onChange } = props;
  const t = P[lang];
  const tg = canRequestContact();
  const [manual, setManual] = useState(!tg || !!value);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const valid = kzPhone(value);

  const share = async () => {
    haptic();
    setBusy(true);
    setNote('');
    const phone = await shareTelegramPhone();
    setBusy(false);
    if (phone && kzPhone(phone)) {
      onChange(kzPhone(phone)!);
      props.onShared?.(kzPhone(phone)!);
    } else if (phone) {
      onChange(phone);
      setManual(true);
      setNote(t.phoneBad);
    } else {
      setManual(true);
      setNote(t.phoneShareFailed);
    }
  };

  return (
    <>
      <Text style={[s.title, { color: c.ink }]}>{props.title ?? t.phoneTitle}</Text>
      <Text style={[s.hint, { color: c.quiet }]}>{props.hint ?? t.phoneStepHint}</Text>
      {tg ? <Button c={c} label={busy ? t.phoneWaiting : t.phoneShare} busy={busy} onPress={share} /> : null}
      {manual ? (
        <Field
          c={c}
          placeholder={t.phonePlaceholder}
          keyboardType="phone-pad"
          inputMode="tel"
          autoComplete="tel"
          value={value}
          onChangeText={(v) => {
            setNote('');
            onChange(v);
          }}
          maxLength={20}
          autoFocus={!tg}
        />
      ) : (
        <Pressable onPress={() => setManual(true)} hitSlop={8}>
          <Text style={[s.link, { color: c.accent }]}>{t.phoneOther}</Text>
        </Pressable>
      )}
      {valid ? (
        <Text style={[s.ok, { color: c.ink }]}>✓ {phoneLabel(valid)}</Text>
      ) : value.replace(/\D/g, '').length >= 10 ? (
        <Text style={[s.note, { color: c.skip }]}>{t.phoneBad}</Text>
      ) : note ? (
        <Text style={[s.note, { color: c.skip }]}>{note}</Text>
      ) : null}
    </>
  );
}

const s = StyleSheet.create({
  title: { fontSize: 24, fontWeight: '800', lineHeight: 30 },
  hint: { fontSize: 14, marginTop: -8, lineHeight: 20 },
  link: { fontSize: 15, fontWeight: '600', textAlign: 'center' },
  ok: { fontSize: 18, fontWeight: '700' },
  note: { fontSize: 14 },
});

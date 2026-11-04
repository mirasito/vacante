// Фото в профиле: выбрать на телефоне, уменьшить, загрузить, заменить и удалить.
// Работодатель видит его на странице профиля вместо букв имени.
import { useCallback, useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { confirm, haptic } from '../platform';
import { deletePhoto, mediaUrl, putPhoto, type ProfileView } from '../server';
import type { Colors } from '../theme';
import type { Lang } from '../types';
import { Button, styles as ui } from '../ui';
import { canPickPhoto, pickPhoto, shrinkPhoto } from './photo';
import { P } from './texts';

/** Своё фото как адрес blob:… (файл закрыт входом Telegram). null, пока фото нет или оно грузится. */
export function usePhotoUrl(view: ProfileView): string | null {
  const stamp = view.photo?.uploaded_at ?? null;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    setUrl(null);
    if (!stamp) return;
    mediaUrl('/me/photo').then((u) => {
      if (alive) setUrl((made = u));
      else if (u) URL.revokeObjectURL(u);
    });
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [stamp]);
  return url;
}

export interface PhotoUpload {
  busy: boolean;
  error: string;
  /** Окно выбора фото. Вызывать прямо в обработчике нажатия. */
  upload(): void;
  remove(): Promise<void>;
}

export function usePhotoUpload(lang: Lang, onChange: (v: ProfileView) => void): PhotoUpload {
  const t = P[lang];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const upload = useCallback(() => {
    if (!canPickPhoto()) return;
    haptic();
    setError('');
    pickPhoto().then(async (file) => {
      if (!file) return;
      setBusy(true);
      try {
        const small = await shrinkPhoto(file);
        if (!small) {
          setError(t.photoBad);
          return;
        }
        onChange(await putPhoto(small));
        haptic('medium');
      } catch {
        setError(t.photoError);
      } finally {
        setBusy(false);
      }
    });
  }, [onChange, t]);

  const remove = useCallback(async () => {
    if (!(await confirm(t.photoRemoveAsk, t.yes, t.no))) return;
    setBusy(true);
    try {
      onChange(await deletePhoto());
    } catch {
      // Не вышло: фото остаётся, можно нажать ещё раз
    } finally {
      setBusy(false);
    }
  }, [onChange, t]);

  return { busy, error, upload, remove };
}

/** Круг с фото или буквами имени, как на странице профиля для работодателя. */
export function Avatar({ c, name, url, size }: { c: Colors; name: string; url: string | null; size: number }) {
  const round = { width: size, height: size, borderRadius: size / 2 };
  return (
    <View style={[s.avatar, round, { backgroundColor: c.pill }]}>
      {url ? (
        <Image source={{ uri: url }} style={round} accessibilityLabel={name} />
      ) : (
        <Text style={[s.initials, { color: c.accent, fontSize: size * 0.38 }]}>{initials(name)}</Text>
      )}
    </View>
  );
}

/** Блок «Фото»: фото с кнопками «Заменить» и «Удалить» или приглашение загрузить. */
export function PhotoSection(props: { c: Colors; lang: Lang; view: ProfileView; photo: PhotoUpload }) {
  const { c, lang, view, photo } = props;
  const t = P[lang];
  const url = usePhotoUrl(view);
  if (!canPickPhoto()) return null;
  const has = !!view.photo;
  return (
    <View style={[s.box, { backgroundColor: c.card, borderColor: c.line }]}>
      <Text style={[s.title, { color: c.ink }]}>📷 {t.photoTitle}</Text>
      <View style={s.row}>
        <Avatar c={c} name={view.profile?.name ?? ''} url={url} size={88} />
        <Text style={[s.text, ui.flex, { color: c.quiet }]}>{photo.busy ? t.photoUploading : t.photoHint}</Text>
      </View>
      {photo.error ? <Text style={[s.text, { color: c.skip }]}>{photo.error}</Text> : null}
      <View style={ui.row}>
        <Button c={c} ghost={has} label={has ? t.photoReplace : t.photoUpload} busy={photo.busy} onPress={photo.upload} />
        {has ? <Button c={c} danger label={t.photoRemove} disabled={photo.busy} onPress={photo.remove} /> : null}
      </View>
    </View>
  );
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');

const s = StyleSheet.create({
  box: { borderWidth: 1, borderRadius: 18, padding: 16, gap: 10 },
  title: { fontSize: 17, fontWeight: '700' },
  text: { fontSize: 15, lineHeight: 21 },
  row: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  avatar: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  initials: { fontWeight: '800' },
});

// Видеокружок в профиле. Снимает его сам Telegram в чате бота (/start video), бот передаёт кружок
// серверу (server/src/internal.ts), а приложение ждёт, пока он появится, показывает его,
// даёт переснять и удалить.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { confirm, haptic, onAppVisible, openBot } from '../platform';
import { deleteVideo, getProfile, mediaUrl, type ProfileView } from '../server';
import type { Colors } from '../theme';
import type { Lang } from '../types';
import { Button, styles as ui } from '../ui';
import { P, when } from './texts';

const POLL_MS = 4000;
/** Дольше не ждём: человек, скорее всего, передумал, а кружок всё равно покажется при следующем входе. */
const WAIT_MS = 10 * 60_000;

/** Когда записан кружок, который сейчас в профиле, или null, если кружка нет. */
const recordedAt = (v: ProfileView | null | undefined) => (v?.video?.ready ? v.video.recorded_at : null);

export interface Recording {
  waiting: boolean;
  start(): void;
}

/**
 * Запись кружка: открываем чат бота и, пока человек записывает, раз в несколько секунд
 * и сразу при возвращении в приложение спрашиваем сервер, не пришёл ли новый кружок.
 */
export function useVideoRecording(view: ProfileView, onChange: (v: ProfileView) => void): Recording {
  // Кружок, который был до записи; undefined — ничего не ждём
  const [since, setSince] = useState<string | null | undefined>(undefined);
  const current = recordedAt(view);
  const arrived = current !== null && current !== since;
  const waiting = since !== undefined && !arrived;
  const change = useRef(onChange);
  change.current = onChange;

  useEffect(() => {
    if (since !== undefined && arrived) {
      setSince(undefined);
      haptic('medium');
    }
  }, [since, arrived]);

  useEffect(() => {
    if (!waiting) return;
    let alive = true;
    const check = () =>
      getProfile().then(
        (v) => {
          const at = recordedAt(v);
          if (alive && v && at !== null && at !== since) change.current(v);
        },
        () => undefined,
      );
    const timer = setInterval(check, POLL_MS);
    const giveUp = setTimeout(() => setSince(undefined), WAIT_MS);
    const off = onAppVisible(check);
    return () => {
      alive = false;
      clearInterval(timer);
      clearTimeout(giveUp);
      off();
    };
  }, [waiting, since]);

  const start = useCallback(() => {
    haptic();
    setSince(current);
    openBot('video');
  }, [current]);

  return { waiting, start };
}

/** Блок «Видеокружок»: сам кружок с кнопками «Переснять» и «Удалить» или приглашение записать. */
export function VideoSection(props: { c: Colors; lang: Lang; view: ProfileView; rec: Recording; onChange(v: ProfileView): void }) {
  const { c, lang, view, rec, onChange } = props;
  const t = P[lang];
  const video = view.video?.ready ? view.video : null;
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    if (!(await confirm(t.videoRemoveAsk, t.yes, t.no))) return;
    setBusy(true);
    try {
      onChange(await deleteVideo());
    } catch {
      // Не вышло: кружок остаётся, можно нажать ещё раз
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[s.box, { backgroundColor: c.card, borderColor: c.line }]}>
      <Text style={[s.title, { color: c.ink }]}>🎥 {t.videoTitle}</Text>
      {video ? (
        <>
          <Circle c={c} label={t.videoPlay} version={video.recorded_at} duration={video.duration} cover={video.poster} />
          <Text style={[s.note, { color: c.quiet }]}>
            {t.videoIn(when(video.recorded_at, lang))} · {clock(video.duration)}
          </Text>
        </>
      ) : (
        <Text style={[s.text, { color: c.quiet }]}>{t.videoHint}</Text>
      )}
      {rec.waiting ? <Text style={[s.text, { color: c.accent }]}>⏳ {t.videoWaiting}</Text> : null}
      <View style={ui.row}>
        <Button c={c} ghost={!!video} label={video ? t.videoRetake : t.videoRecord} onPress={rec.start} />
        {video ? <Button c={c} danger label={t.videoRemove} busy={busy} onPress={remove} /> : null}
      </View>
    </View>
  );
}

/**
 * Кружок как в Telegram: обложка с длительностью, по нажатию видео со звуком прямо в круге.
 * Файлы закрыты входом, поэтому качаем их сами (mediaUrl) и отпускаем, когда кружок сменился.
 */
function Circle(props: { c: Colors; label: string; version: string; duration: number; cover: boolean }) {
  const { c, label, version, duration, cover } = props;
  const [poster, setPoster] = useState<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const player = useRef<HTMLVideoElement | null>(null);
  const shown = useRef(version);
  shown.current = version;

  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    setPoster(null);
    setSrc(null);
    setState('idle');
    if (!cover) return;
    mediaUrl('/me/video/poster').then((u) => {
      if (alive) setPoster((url = u));
      else if (u) URL.revokeObjectURL(u);
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [version, cover]);

  useEffect(
    () => () => {
      if (src) URL.revokeObjectURL(src);
    },
    [src],
  );

  const press = async () => {
    const el = player.current;
    if (el) {
      // Если Telegram не дал включить видео само, второе нажатие запускает его наверняка
      if (el.paused) el.play().catch(() => undefined);
      else el.pause();
      return;
    }
    if (state === 'loading' || Platform.OS !== 'web') return;
    haptic();
    setState('loading');
    const u = await mediaUrl('/me/video');
    if (u && shown.current !== version) URL.revokeObjectURL(u);
    else if (u) setSrc(u);
    setState('idle');
  };

  return (
    <Pressable
      onPress={press}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[s.circle, { backgroundColor: c.line }]}
    >
      {src ? (
        <video
          ref={player}
          src={src}
          poster={poster ?? undefined}
          autoPlay
          playsInline
          onPlay={() => setState('playing')}
          onPause={() => setState('idle')}
          onEnded={() => setState('idle')}
          style={VIDEO_STYLE}
        />
      ) : poster ? (
        <Image source={{ uri: poster }} style={s.fill} />
      ) : null}
      {state !== 'playing' ? (
        <View style={s.play}>
          <Text style={s.playText}>{state === 'loading' ? '…' : `▶ ${clock(duration)}`}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** 42 → «0:42». */
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds) % 60).padStart(2, '0')}`;

const SIZE = 168;

// Safari не всегда обрезает видео по скруглению родителя, поэтому круг задан и самому видео
const VIDEO_STYLE = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  borderRadius: '50%',
  display: 'block',
} as const;

const s = StyleSheet.create({
  box: { borderWidth: 1, borderRadius: 18, padding: 16, gap: 10 },
  title: { fontSize: 17, fontWeight: '700' },
  text: { fontSize: 15, lineHeight: 21 },
  note: { fontSize: 14, textAlign: 'center' },
  circle: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    overflow: 'hidden',
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  fill: { position: 'absolute', top: 0, left: 0, width: SIZE, height: SIZE },
  play: { marginBottom: 14, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.55)' },
  playText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});

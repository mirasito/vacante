import { useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, type Ref } from 'react';
import {
  Animated,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import * as i18n from './i18n';
import type { Colors } from './theme';
import type { Lang, Vacancy } from './types';
import { VacancyCard } from './VacancyCard';

export type Dir = 'left' | 'right';
export type DeckHandle = { swipe(dir: Dir): void };

type Props = {
  items: Vacancy[];
  lang: Lang;
  c: Colors;
  onSwipe(v: Vacancy, dir: Dir): void;
  onOpen(v: Vacancy): void;
  ref?: Ref<DeckHandle>;
};

/** Стопка карточек: верхнюю тянут пальцем, следующая уже видна под ней. */
export function SwipeDeck({ items, lang, c, onSwipe, onOpen, ref }: Props) {
  const { width } = useWindowDimensions();
  const span = Math.min(width, 480);
  const pos = useRef(new Animated.ValueXY()).current;
  const busy = useRef(false);
  const top = items[0];
  const latest = useRef({ top, onSwipe });
  latest.current = { top, onSwipe };

  // Новая верхняя карточка встаёт в центр только после того, как React её отрисовал,
  // иначе на кадр мелькнула бы улетевшая
  useLayoutEffect(() => {
    pos.setValue({ x: 0, y: 0 });
    busy.current = false;
  }, [top?.id, pos]);

  const fling = useCallback(
    (dir: Dir) => {
      const current = latest.current.top;
      if (!current || busy.current) return;
      busy.current = true;
      Animated.timing(pos, {
        toValue: { x: (dir === 'right' ? 1 : -1) * span * 1.6, y: 0 },
        duration: 220,
        useNativeDriver: false,
      }).start(() => latest.current.onSwipe(current, dir));
    },
    [pos, span],
  );

  useImperativeHandle(ref, () => ({ swipe: fling }), [fling]);

  const pan = useMemo(() => {
    const back = () =>
      Animated.spring(pos, { toValue: { x: 0, y: 0 }, friction: 6, useNativeDriver: false }).start();
    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_, g) => pos.setValue({ x: g.dx, y: g.dy * 0.25 }),
      onPanResponderRelease: (_, g) => {
        if (g.dx > span * 0.25 || g.vx > 0.8) fling('right');
        else if (g.dx < -span * 0.25 || g.vx < -0.8) fling('left');
        else back();
      },
      onPanResponderTerminate: back,
    });
  }, [pos, span, fling]);

  const rotate = pos.x.interpolate({
    inputRange: [-span, 0, span],
    outputRange: ['-10deg', '0deg', '10deg'],
  });
  const likeOpacity = pos.x.interpolate({ inputRange: [0, span * 0.25], outputRange: [0, 1], extrapolate: 'clamp' });
  const skipOpacity = pos.x.interpolate({ inputRange: [-span * 0.25, 0], outputRange: [1, 0], extrapolate: 'clamp' });
  const nextScale = pos.x.interpolate({
    inputRange: [-span * 0.5, 0, span * 0.5],
    outputRange: [1, 0.95, 1],
    extrapolate: 'clamp',
  });

  const next = items[1];
  const cardStyle = [styles.card, { backgroundColor: c.card, borderColor: c.line }];
  return (
    <View style={styles.deck}>
      {next ? (
        <Animated.View key={next.id} style={[cardStyle, { transform: [{ scale: nextScale }] }]}>
          <VacancyCard v={next} lang={lang} c={c} />
        </Animated.View>
      ) : null}
      {top ? (
        <Animated.View
          key={top.id}
          style={[cardStyle, noSelect, { transform: [...pos.getTranslateTransform(), { rotate }] }]}
          {...pan.panHandlers}
        >
          <Pressable style={styles.fill} onPress={() => onOpen(top)}>
            <VacancyCard v={top} lang={lang} c={c} />
          </Pressable>
          <Animated.View style={[styles.stamp, styles.likeStamp, { borderColor: c.like, opacity: likeOpacity }]}>
            <Text style={[styles.stampText, { color: c.like }]}>{i18n.t(lang, 'like').toUpperCase()}</Text>
          </Animated.View>
          <Animated.View style={[styles.stamp, styles.skipStamp, { borderColor: c.skip, opacity: skipOpacity }]}>
            <Text style={[styles.stampText, { color: c.skip }]}>{i18n.t(lang, 'skip').toUpperCase()}</Text>
          </Animated.View>
        </Animated.View>
      ) : null}
    </View>
  );
}

// В браузере и Telegram без этого при перетаскивании выделяется текст
const noSelect = Platform.OS === 'web' ? ({ userSelect: 'none', cursor: 'grab' } as object) : {};

const styles = StyleSheet.create({
  deck: { flex: 1 },
  fill: { flex: 1 },
  card: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  stamp: {
    position: 'absolute',
    top: 28,
    borderWidth: 3,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  likeStamp: { left: 20, transform: [{ rotate: '-12deg' }] },
  skipStamp: { right: 20, transform: [{ rotate: '12deg' }] },
  stampText: { fontSize: 24, fontWeight: '900', letterSpacing: 1 },
});

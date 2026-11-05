// Лента «Рядом» из макета vacante 2.0: список карточек. Карточку можно смахнуть:
// вправо — сохранить (и откликнуться), влево — скрыть. Те же действия есть кнопками.
import { useMemo, useRef, type ReactElement } from 'react';
import { Animated, FlatList, PanResponder, Platform, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { Point } from './geo';
import * as i18n from './i18n';
import type { Colors } from './theme';
import type { Lang, Vacancy } from './types';
import { VacancyCard } from './VacancyCard';

export type Dir = 'left' | 'right';

type Props = {
  items: Vacancy[];
  lang: Lang;
  c: Colors;
  /** Дом из профиля: на карточках видно, далеко ли работа. */
  home?: Point | null;
  /** Строка над карточками: сколько вакансий, «Вернуть». */
  header?: ReactElement;
  /** Подсказка под первой карточкой. */
  tip?: boolean;
  /** «Почему вам: …» под карточкой. */
  reason?(v: Vacancy): string | null;
  onSwipe(v: Vacancy, dir: Dir): void;
  onOpen(v: Vacancy): void;
  onApply(v: Vacancy): void;
  /** Конец ленты близко: догрузить следующую страницу города. */
  onEnd?(): void;
};

export function FeedList({ items, lang, c, home, header, tip, reason, onSwipe, onOpen, onApply, onEnd }: Props) {
  return (
    <FlatList
      data={items}
      keyExtractor={(v) => v.id}
      ListHeaderComponent={header}
      contentContainerStyle={styles.list}
      initialNumToRender={6}
      onEndReached={onEnd}
      onEndReachedThreshold={3}
      windowSize={7}
      renderItem={({ item: v, index }) => (
        <>
          <SwipeRow c={c} lang={lang} onSwipe={(dir) => onSwipe(v, dir)}>
            <VacancyCard
              v={v}
              lang={lang}
              c={c}
              home={home}
              reason={reason?.(v)}
              onOpen={() => onOpen(v)}
              onSave={() => onSwipe(v, 'right')}
              onApply={() => onApply(v)}
            />
          </SwipeRow>
          {tip && index === 0 ? <Text style={[styles.tip, { color: c.quiet }]}>{i18n.t(lang, 'swipeTip')}</Text> : null}
        </>
      )}
    />
  );
}

/** Строка, которую тянут пальцем в сторону; за краем порога улетает и сообщает направление. */
function SwipeRow({ c, lang, children, onSwipe }: { c: Colors; lang: Lang; children: ReactElement; onSwipe(dir: Dir): void }) {
  const { width } = useWindowDimensions();
  const span = Math.min(width, 520);
  const x = useRef(new Animated.Value(0)).current;
  const latest = useRef(onSwipe);
  latest.current = onSwipe;

  const pan = useMemo(() => {
    let busy = false;
    const back = () => Animated.spring(x, { toValue: 0, friction: 6, useNativeDriver: false }).start();
    const fling = (dir: Dir) => {
      busy = true;
      Animated.timing(x, { toValue: (dir === 'right' ? 1 : -1) * span * 1.2, duration: 200, useNativeDriver: false }).start(
        () => {
          latest.current(dir);
          // Строку могут и не убрать (например, окно отклика закрыли): возвращаем на место
          x.setValue(0);
          busy = false;
        },
      );
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) => !busy && Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, g) => x.setValue(g.dx),
      onPanResponderRelease: (_, g) => {
        if (g.dx > span * 0.3 || g.vx > 0.9) fling('right');
        else if (g.dx < -span * 0.3 || g.vx < -0.9) fling('left');
        else back();
      },
      onPanResponderTerminate: back,
    });
  }, [x, span]);

  const rotate = x.interpolate({ inputRange: [-span, 0, span], outputRange: ['-4deg', '0deg', '4deg'] });
  const save = x.interpolate({ inputRange: [0, span * 0.3], outputRange: [0, 1], extrapolate: 'clamp' });
  const hide = x.interpolate({ inputRange: [-span * 0.3, 0], outputRange: [1, 0], extrapolate: 'clamp' });
  return (
    <View>
      <Animated.View style={[styles.under, styles.underLeft, { backgroundColor: c.okBg, opacity: save }]}>
        <Text style={[styles.underText, { color: c.okInk }]}>{i18n.t(lang, 'like')}</Text>
      </Animated.View>
      <Animated.View style={[styles.under, styles.underRight, { backgroundColor: c.pill, opacity: hide }]}>
        <Text style={[styles.underText, { color: c.quiet }]}>{i18n.t(lang, 'skip')}</Text>
      </Animated.View>
      <Animated.View
        style={[noSelect, { transform: [{ translateX: x }, { rotate }] }]}
        accessibilityActions={[
          { name: 'save', label: i18n.t(lang, 'like') },
          { name: 'hide', label: i18n.t(lang, 'skip') },
        ]}
        onAccessibilityAction={(e) => onSwipe(e.nativeEvent.actionName === 'save' ? 'right' : 'left')}
        {...pan.panHandlers}
      >
        {children}
      </Animated.View>
    </View>
  );
}

// В браузере и Telegram без этого при перетаскивании выделяется текст
const noSelect = Platform.OS === 'web' ? ({ userSelect: 'none' } as object) : {};

const styles = StyleSheet.create({
  list: { paddingHorizontal: 20, paddingBottom: 24, gap: 12 },
  tip: { textAlign: 'center', fontSize: 13, paddingTop: 10 },
  under: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, borderRadius: 16, justifyContent: 'center', paddingHorizontal: 20 },
  underLeft: { alignItems: 'flex-start' },
  underRight: { alignItems: 'flex-end' },
  underText: { fontSize: 15, fontWeight: '800' },
});

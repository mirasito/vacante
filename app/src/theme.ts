import { useEffect, useReducer } from 'react';
import { useColorScheme } from 'react-native';

import { onThemeChanged, telegram } from './platform';

// Цвета vacante 2.0 (макет «vacante 2.0 — макеты экранов»): белый фон, карточки с тонкой рамкой,
// терракотовый акцент, тёмные выбранные чипы, зелёный «хорошо» и янтарный «внимание».
const light = {
  bg: '#ffffff',
  card: '#ffffff',
  ink: '#141413',
  quiet: '#5C6066',
  /** Значки и стрелки, которые не надо читать. */
  faint: '#9AA0A8',
  line: '#E3E5E9',
  accent: '#C2410C',
  /** Серый фон: вторичные кнопки, бейджи, переключатель. */
  pill: '#F0F2F5',
  /** Плашки фактов о вакансии. */
  soft: '#F7F8FA',
  like: '#15803D',
  skip: '#B91C1C',
  hot: '#B45309',
  okBg: '#E3F4EA',
  okInk: '#15803D',
  warnBg: '#FDF1E1',
  warnLine: '#F5D9A8',
  warnInk: '#7A4A08',
  /** Выбранный чип и тёмные карточки: фон и текст на нём. */
  strong: '#141413',
  onStrong: '#ffffff',
};

const dark: typeof light = {
  bg: '#0f0f10',
  card: '#18181a',
  ink: '#f2f2f3',
  quiet: '#a1a1a8',
  faint: '#6b6b70',
  line: '#2c2c30',
  accent: '#D24A12',
  pill: '#26262a',
  soft: '#1f1f22',
  like: '#4ade80',
  skip: '#f87171',
  hot: '#fbbf24',
  okBg: '#173524',
  okInk: '#86efac',
  warnBg: '#33260f',
  warnLine: '#5c4413',
  warnInk: '#fcd9a0',
  strong: '#f2f2f3',
  onStrong: '#141413',
};

export type Colors = typeof light;

export function useColors(): Colors {
  const scheme = useColorScheme();
  // В Telegram своя тема, она может не совпадать с темой телефона
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onThemeChanged(refresh), []);
  const tg = telegram()?.colorScheme;
  return (tg ?? scheme) === 'dark' ? dark : light;
}

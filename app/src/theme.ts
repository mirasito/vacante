import { useEffect, useReducer } from 'react';
import { useColorScheme } from 'react-native';

import { onThemeChanged, telegram } from './platform';

// Цвета vacante в стиле логотипа «.вакантэ»: графит #1B2023 и голубая точка #8AF0FF.
// Светлая тема: белый фон, графитовые кнопки и выбранные чипы, голубой — для точечных акцентов.
// Тёмная тема — как сам логотип: графитовый фон и голубые кнопки с графитовым текстом.
const light = {
  /** Какая версия логотипа: тёмные буквы на светлом или белые на тёмном. */
  mode: 'light' as 'light' | 'dark',
  bg: '#ffffff',
  card: '#ffffff',
  ink: '#1B2023',
  quiet: '#5C6066',
  /** Значки и стрелки, которые не надо читать. */
  faint: '#9AA0A8',
  line: '#E3E5E9',
  /** Главные кнопки, активная вкладка, выделенный текст. */
  accent: '#1B2023',
  /** Текст и значки на accent. */
  onAccent: '#ffffff',
  /** Голубая точка логотипа: счётчики, полоски прогресса, маленькие акценты. */
  brand: '#0A8CA8',
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
  strong: '#1B2023',
  onStrong: '#ffffff',
};

const dark: typeof light = {
  mode: 'dark',
  bg: '#1B2023',
  card: '#22292D',
  ink: '#F2F5F6',
  quiet: '#A3ADB3',
  faint: '#6B767C',
  line: '#323B40',
  accent: '#8AF0FF',
  onAccent: '#1B2023',
  brand: '#8AF0FF',
  pill: '#2B3337',
  soft: '#252D31',
  like: '#4ade80',
  skip: '#f87171',
  hot: '#fbbf24',
  okBg: '#173524',
  okInk: '#86efac',
  warnBg: '#33260f',
  warnLine: '#5c4413',
  warnInk: '#fcd9a0',
  strong: '#F2F5F6',
  onStrong: '#1B2023',
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

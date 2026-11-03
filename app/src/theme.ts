import { useEffect, useReducer } from 'react';
import { useColorScheme } from 'react-native';

import { onThemeChanged, telegram } from './platform';

// Цвета сайта vacante.kz (vacante/site/static/style.css)
const light = {
  bg: '#f4f4f6',
  card: '#ffffff',
  ink: '#1d1d1f',
  quiet: '#6b6b70',
  line: '#e4e4e7',
  accent: '#0a8ff0',
  pill: '#e3f1fd',
  like: '#16a34a',
  skip: '#e11d48',
  hot: '#f97316',
};

const dark: typeof light = {
  bg: '#0f0f10',
  card: '#1d1d20',
  ink: '#f2f2f3',
  quiet: '#a1a1a8',
  line: '#2c2c30',
  accent: '#3aa5f5',
  pill: '#12304a',
  like: '#22c55e',
  skip: '#fb7185',
  hot: '#fb923c',
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

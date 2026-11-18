// Вход на сайт vacante.kz вне Telegram. Внутри Mini App сервер узнаёт человека по initData,
// а в браузере и в приложении для телефона — по ключу входа: его выдаёт бот, когда человек
// нажал «Войти через Telegram» и подтвердил кнопкой в чате (bot/src/login.js). Ключ живёт 30 дней,
// подходит и серверу профилей (api.vacante.kz), и кабинету работодателя в боте.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { telegram } from './platform';

export const LOGIN_URL = 'https://vacante-bot.vacante-kz.workers.dev/api/login';
const KEY = 'vacante.session';
// Так ключ звался, когда вход был только у кабинета работодателя (PR #170)
const OLD_KEY = 'vacante.employer.session';
const isWeb = Platform.OS === 'web';

function webGet(key: string): string {
  try {
    return (typeof localStorage !== 'undefined' && localStorage.getItem(key)) || '';
  } catch {
    return ''; // приватный режим: войдут ещё раз
  }
}

let cached: string | null = null;
const listeners = new Set<() => void>();

/** Ключ входа с сайта или пустая строка. В браузере читается сразу, на телефоне — после loadSession(). */
export function getSession(): string {
  if (cached === null && isWeb) cached = webGet(KEY) || webGet(OLD_KEY);
  return cached ?? '';
}

/** Прочитать ключ при запуске (на телефоне хранилище отвечает не сразу). */
export async function loadSession(): Promise<string> {
  if (isWeb || cached !== null) return getSession();
  try {
    cached = (await AsyncStorage.getItem(KEY)) || '';
  } catch {
    cached = '';
  }
  return cached;
}

/** Сохранить ключ после входа или стереть его (выход, ключ устарел). */
export function setSession(value: string) {
  if (value === getSession()) return;
  cached = value;
  if (isWeb) {
    try {
      if (value) localStorage.setItem(KEY, value);
      else localStorage.removeItem(KEY);
      localStorage.removeItem(OLD_KEY);
    } catch {
      // нет хранилища: ключ живёт до закрытия вкладки
    }
  } else {
    (value ? AsyncStorage.setItem(KEY, value) : AsyncStorage.removeItem(KEY)).catch(() => undefined);
  }
  listeners.forEach((fn) => fn());
}

/** Подписка на вход и выход: приложение заново узнаёт, кто это. */
export function onSessionChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Данные входа из Telegram, их проверяют подписью бота. Вне Telegram их нет. */
export const initData = () => telegram()?.initData || '';

/** Заголовок Authorization: initData в Telegram, иначе ключ с сайта; пусто — нужно войти. */
export const authHeader = () => (initData() ? `tma ${initData()}` : getSession() ? `session ${getSession()}` : '');

/** Человек вошёл на сайте через бота (не в Telegram): ему показываем «Выйти». */
export const siteSignedIn = () => !initData() && !!getSession();

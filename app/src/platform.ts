import { useEffect, useRef } from 'react';
import { Linking, Platform, Share } from 'react-native';

// Внутри Telegram приложение открывается как Mini App: окно Telegram.WebApp даёт тему,
// вибрацию и ссылки, которые открываются, не закрывая приложение.
export type HomeScreen = 'unsupported' | 'unknown' | 'added' | 'missed';

type WebApp = {
  version?: string;
  isVersionAtLeast?(version: string): boolean;
  ready(): void;
  expand(): void;
  disableVerticalSwipes?(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  openLink(url: string): void;
  openTelegramLink(url: string): void;
  onEvent?(event: string, callback: () => void): void;
  offEvent?(event: string, callback: () => void): void;
  colorScheme?: 'light' | 'dark';
  /** Подписанная строка входа: её проверяет сервер (server/src/telegram.ts). */
  initData?: string;
  initDataUnsafe?: { user?: { language_code?: string }; start_param?: string };
  BackButton?: {
    show(): void;
    hide(): void;
    onClick(callback: () => void): void;
    offClick(callback: () => void): void;
  };
  addToHomeScreen?(): void;
  checkHomeScreenStatus?(callback: (status: HomeScreen) => void): void;
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy'): void;
    selectionChanged(): void;
  };
};

declare global {
  interface Window {
    Telegram?: { WebApp?: WebApp };
  }
}

const isWeb = Platform.OS === 'web' && typeof window !== 'undefined';

export const telegram = (): WebApp | undefined => (isWeb ? window.Telegram?.WebApp : undefined);

/** Открыто ли приложение из Telegram: Telegram передаёт данные запуска в адресе страницы. */
export const inTelegram = () =>
  isWeb && /tgWebApp/.test(window.location.hash + window.location.search);

/** Есть ли у Telegram пользователя нужная версия Mini Apps (иначе метод только пишет предупреждение). */
const supports = (app: WebApp | undefined, version: string): app is WebApp =>
  !!app && !!app.isVersionAtLeast?.(version);

let started: Promise<WebApp | undefined> | undefined;

/** Подключает telegram-web-app.js один раз, сколько бы раз его ни ждали. */
export function initTelegram(): Promise<WebApp | undefined> {
  started ??= start();
  return started;
}

function start(): Promise<WebApp | undefined> {
  if (!inTelegram()) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const done = () => {
      const app = telegram();
      if (app) {
        app.ready();
        app.expand();
        // Иначе вертикальный жест сворачивает Mini App вместо свайпа карточки
        app.disableVerticalSwipes?.();
      }
      resolve(app);
    };
    if (telegram()) return done();
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-web-app.js';
    script.onload = done;
    script.onerror = () => resolve(undefined);
    document.head.appendChild(script);
  });
}

export function haptic(kind: 'light' | 'medium' = 'light') {
  telegram()?.HapticFeedback?.impactOccurred(kind);
}

export function openUrl(url: string) {
  const app = telegram();
  if (app) {
    if (/^https:\/\/t\.me\//.test(url)) app.openTelegramLink(url);
    else app.openLink(url);
    return;
  }
  if (isWeb) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  Linking.openURL(url).catch(() => undefined);
}

export async function shareLink(text: string, url: string) {
  const app = telegram();
  if (app) {
    app.openTelegramLink(
      `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
    );
    return;
  }
  if (isWeb) {
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (nav.share) {
      await nav.share({ text, url }).catch(() => undefined);
      return;
    }
    openUrl(`https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}`);
    return;
  }
  await Share.share({ message: `${text}\n${url}` }).catch(() => undefined);
}

export const whatsapp = (text: string, url: string) =>
  openUrl(`https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}`);


/**
 * Город из ссылки, по которой открыли приложение: кнопка бота добавляет ?city=almaty,
 * а ссылка t.me/vacantekz_bot?startapp=almaty передаёт его в start_param.
 */
export function launchCity(): string | undefined {
  if (!isWeb) return undefined;
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const value =
    query.get('city') ??
    telegram()?.initDataUnsafe?.start_param ??
    query.get('tgWebAppStartParam') ??
    hash.get('tgWebAppStartParam');
  return value && /^[a-z][a-z-]{1,30}$/.test(value) ? value : undefined;
}

/**
 * Кнопка «Назад» в шапке Telegram (на Android на неё же уходит системная «Назад»).
 * Пока active, кнопка видна и вызывает onBack; без Telegram ничего не делает.
 */
export function useBackButton(active: boolean, onBack: () => void) {
  const handler = useRef(onBack);
  handler.current = onBack;
  useEffect(() => {
    const button = telegram()?.BackButton;
    if (!active || !button || !supports(telegram(), '6.1')) return;
    const click = () => handler.current();
    button.onClick(click);
    button.show();
    return () => {
      button.offClick(click);
      button.hide();
    };
  }, [active]);
}

/** Тема Telegram сменилась (пользователь переключил светлую или тёмную). */
export function onThemeChanged(callback: () => void): () => void {
  let app: WebApp | undefined;
  let alive = true;
  initTelegram().then((tg) => {
    if (!alive || !tg?.onEvent) return;
    app = tg;
    tg.onEvent('themeChanged', callback);
  });
  return () => {
    alive = false;
    app?.offEvent?.('themeChanged', callback);
  };
}

/** Можно ли добавить Mini App значком на экран телефона (Telegram 8.0+). */
export async function homeScreenStatus(): Promise<HomeScreen> {
  const app = await initTelegram();
  if (!supports(app, '8.0') || !app.checkHomeScreenStatus) return 'unsupported';
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('unsupported'), 3000);
    app.checkHomeScreenStatus!((status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
}

export function addToHomeScreen() {
  const app = telegram();
  if (supports(app, '8.0')) app.addToHomeScreen?.();
}

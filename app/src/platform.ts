import { useEffect, useRef } from 'react';
import { Alert, Linking, Platform, Share } from 'react-native';

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
  /** Окно Telegram «Поделиться номером»: номер приходит боту сообщением-контактом (Bot API 6.9). */
  requestContact?(callback: (shared: boolean) => void): void;
  /** Окно Telegram «Разрешить боту писать вам» (Bot API 6.9). */
  requestWriteAccess?(callback: (allowed: boolean) => void): void;
  showConfirm?(message: string, callback: (ok: boolean) => void): void;
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


export const BOT = 'vacantekz_bot';

/** start_param ссылки t.me/vacantekz_bot?startapp=… */
function startParam(): string | undefined {
  if (!isWeb) return undefined;
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.slice(1));
  return telegram()?.initDataUnsafe?.start_param ?? query.get('tgWebAppStartParam') ?? hash.get('tgWebAppStartParam') ?? undefined;
}

/** Тестовая ссылка t.me/vacantekz_bot?startapp=beta: профиль до общего запуска. */
export const launchBeta = () => startParam() === 'beta';

/**
 * Город из ссылки, по которой открыли приложение: кнопка бота добавляет ?city=almaty,
 * а ссылка t.me/vacantekz_bot?startapp=almaty передаёт его в start_param.
 */
export function launchCity(): string | undefined {
  if (!isWeb) return undefined;
  const value = new URLSearchParams(window.location.search).get('city') ?? startParam();
  return value && value !== 'beta' && /^[a-z][a-z-]{1,30}$/.test(value) ? value : undefined;
}

/** Вкладка из ссылки: кнопка бота «Открыть профиль» открывает приложение с ?tab=profile. */
export function launchTab(): 'profile' | undefined {
  if (!isWeb) return undefined;
  return new URLSearchParams(window.location.search).get('tab') === 'profile' ? 'profile' : undefined;
}

/**
 * Человек вернулся в приложение: из чата бота, из другой программы или развернул свёрнутое окно
 * (событие activated есть в Telegram 8.0+). Возвращает отписку.
 */
export function onAppVisible(callback: () => void): () => void {
  if (!isWeb || typeof document === 'undefined') return () => undefined;
  const app = telegram();
  const visible = () => {
    if (document.visibilityState === 'visible') callback();
  };
  document.addEventListener('visibilitychange', visible);
  app?.onEvent?.('activated', callback);
  return () => {
    document.removeEventListener('visibilitychange', visible);
    app?.offEvent?.('activated', callback);
  };
}

/** Открыть чат с ботом; в Telegram 7.0+ приложение при этом не закрывается. */
export const openBot = (start?: string) => openUrl(`https://t.me/${BOT}${start ? `?start=${start}` : ''}`);

/** Есть ли окно Telegram «Поделиться номером» (Telegram 6.9+). */
export const canRequestContact = () => {
  const app = telegram();
  return supports(app, '6.9') && !!app.requestContact;
};

/** Номер из Telegram одной кнопкой. true, если человек поделился. */
export function requestContact(): Promise<boolean> {
  const app = telegram();
  if (!canRequestContact() || !app?.requestContact) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      app.requestContact!((shared) => resolve(!!shared));
    } catch {
      resolve(false); // окно уже открыто
    }
  });
}

/** Разрешение боту писать первым: без него напоминания в бот не дойдут. */
export function requestWriteAccess(): Promise<boolean> {
  const app = telegram();
  if (!supports(app, '6.9') || !app.requestWriteAccess) return Promise.resolve(false);
  return new Promise((resolve) => app.requestWriteAccess!((allowed) => resolve(!!allowed)));
}

/** Вопрос «Да / Нет» окном Telegram, браузера или телефона. */
export function confirm(message: string, yes: string, no: string): Promise<boolean> {
  const app = telegram();
  if (supports(app, '6.2') && app.showConfirm) {
    return new Promise((resolve) => app.showConfirm!(message, (ok) => resolve(!!ok)));
  }
  if (isWeb) return Promise.resolve(window.confirm(message));
  return new Promise((resolve) =>
    Alert.alert('', message, [
      { text: no, style: 'cancel', onPress: () => resolve(false) },
      { text: yes, style: 'destructive', onPress: () => resolve(true) },
    ]),
  );
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

import { Linking, Platform, Share } from 'react-native';

// Внутри Telegram приложение открывается как Mini App: окно Telegram.WebApp даёт тему,
// вибрацию и ссылки, которые открываются, не закрывая приложение.
type WebApp = {
  ready(): void;
  expand(): void;
  disableVerticalSwipes?(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  openLink(url: string): void;
  openTelegramLink(url: string): void;
  colorScheme?: 'light' | 'dark';
  initDataUnsafe?: { user?: { language_code?: string } };
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

export function initTelegram(): Promise<WebApp | undefined> {
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

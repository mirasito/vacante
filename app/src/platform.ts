import { useEffect, useRef } from 'react';
import { Alert, Linking, Platform, Share } from 'react-native';

// Внутри Telegram приложение открывается как Mini App: окно Telegram.WebApp даёт тему,
// вибрацию и ссылки, которые открываются, не закрывая приложение.
export type HomeScreen = 'unsupported' | 'unknown' | 'added' | 'missed';

type WebApp = {
  version?: string;
  /** ios, android, tdesktop, macos, web… */
  platform?: string;
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
  /** Геопозиция с разрешения человека (Bot API 8.0). */
  LocationManager?: {
    isInited: boolean;
    isLocationAvailable: boolean;
    isAccessRequested: boolean;
    isAccessGranted: boolean;
    init(callback?: () => void): void;
    getLocation(callback: (data: { latitude: number; longitude: number } | null) => void): void;
    openSettings(): void;
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

// Шрифт Manrope из макета vacante 2.0. Файлы лежат рядом с приложением (public/fonts, лицензия OFL),
// без запросов к Google. Только в вебе и Mini App: в сборках для телефонов остаётся системный шрифт.
// Путь от корня сайта: приложение живёт в /app (experiments.baseUrl в app.json).
const FONT_FILES: [string, string][] = [
  ['latin', 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2212,U+FEFF,U+FFFD'],
  ['latin-ext', 'U+0100-02BA,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'],
  ['cyrillic', 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116'],
  ['cyrillic-ext', 'U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F'],
];

export function loadWebFont() {
  if (!isWeb || typeof document === 'undefined' || document.getElementById('vacante-font')) return;
  const faces = FONT_FILES.map(
    ([name, range]) =>
      `@font-face{font-family:Manrope;font-style:normal;font-weight:200 800;font-display:swap;` +
      `src:url(/app/fonts/manrope-${name}-wght-normal.woff2) format('woff2');unicode-range:${range}}`,
  ).join('');
  const style = document.createElement('style');
  style.id = 'vacante-font';
  // У каждого текста React Native Web свой класс со шрифтом, поэтому !important
  style.textContent = `${faces}body,body *{font-family:Manrope,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif!important;-webkit-font-smoothing:antialiased}`;
  document.head.appendChild(style);
}

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
  // Звонок: Telegram открывает только http(s), поэтому tel: отдаём самому окну
  if (/^tel:/.test(url)) {
    if (isWeb) window.location.href = url;
    else Linking.openURL(url).catch(() => undefined);
    return;
  }
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
    openWhatsapp(`${text}\n${url}`);
    return;
  }
  await Share.share({ message: `${text}\n${url}` }).catch(() => undefined);
}

/**
 * Копирует текст. Вызывать прямо в обработчике нажатия: браузеры разрешают запись в буфер
 * только в ответ на действие человека. true, если получилось.
 */
export function copyText(text: string): boolean {
  if (!isWeb) return false;
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => copyByCommand(text));
      return true;
    }
  } catch {
    // ниже запасной способ
  }
  return copyByCommand(text);
}

function copyByCommand(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Открыто на iPhone или iPad: в Telegram это говорит сам Telegram, в браузере — адрес браузера. */
function onIos(): boolean {
  const platform = telegram()?.platform;
  if (platform) return platform === 'ios';
  return isWeb && /iPhone|iPad|iPod/.test(navigator.userAgent);
}

/**
 * WhatsApp с готовым текстом: с номером — сразу чат с ним, без номера — выбор, кому отправить.
 * На iPhone ссылка https://wa.me из Telegram открывала WhatsApp без выбора чата, поэтому там
 * сначала пробуем сам WhatsApp (whatsapp://send). Если за полторы секунды он не открылся
 * (его нет или Telegram не пустил), открываем wa.me, как раньше.
 */
export function openWhatsapp(text: string, phone?: string) {
  const digits = phone?.replace(/\D/g, '') ?? '';
  const encoded = encodeURIComponent(text);
  const web = `https://wa.me/${digits}?text=${encoded}`;
  const app = `whatsapp://send?${digits ? `phone=${digits}&` : ''}text=${encoded}`;
  if (!isWeb) {
    Linking.openURL(app).catch(() => Linking.openURL(web).catch(() => undefined));
    return;
  }
  if (!onIos()) {
    openUrl(web);
    return;
  }
  let away = false;
  const leave = () => {
    if (document.visibilityState === 'hidden') away = true;
  };
  const blur = () => {
    away = true;
  };
  document.addEventListener('visibilitychange', leave);
  window.addEventListener('pagehide', blur);
  window.addEventListener('blur', blur);
  window.location.href = app;
  setTimeout(() => {
    document.removeEventListener('visibilitychange', leave);
    window.removeEventListener('pagehide', blur);
    window.removeEventListener('blur', blur);
    if (!away && document.visibilityState === 'visible') openUrl(web);
  }, 1500);
}

export const whatsapp = (text: string, url: string) => openWhatsapp(`${text}\n${url}`);

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

/** Код приглашения из ссылки друга t.me/vacantekz_bot?startapp=ref_abc123. */
export function launchRef(): string | undefined {
  const m = /^ref_([a-z0-9]{6})$/.exec(startParam() ?? '');
  return m?.[1];
}

/** Переписка из сообщения бота «Ответ по отклику»: ?tab=chats&chat=12. */
export function launchChat(): number | undefined {
  if (!isWeb) return undefined;
  const id = Number(new URLSearchParams(window.location.search).get('chat'));
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** Скачать файл: в Telegram 8.0+ его окном загрузки, иначе ссылкой в браузере. */
export function downloadFile(url: string, name: string) {
  const app = telegram() as (WebApp & { downloadFile?(p: { url: string; file_name: string }): void }) | undefined;
  if (app?.downloadFile && supports(app, '8.0')) {
    try {
      app.downloadFile({ url, file_name: name });
      return;
    } catch {
      // старый клиент: откроем ссылкой
    }
  }
  openUrl(url);
}

/**
 * Вкладка из ссылки: кнопка бота «Открыть профиль» открывает приложение с ?tab=profile,
 * сообщения об откликах — с ?tab=applications, напоминания — с ?tab=reminders.
 */
export function launchTab(): 'profile' | 'applications' | 'reminders' | 'chats' | undefined {
  if (!isWeb) return undefined;
  const tab = new URLSearchParams(window.location.search).get('tab');
  return tab === 'profile' || tab === 'applications' || tab === 'reminders' || tab === 'chats' ? tab : undefined;
}

/** Отклик из ссылки: кнопка «Перенести» под напоминанием о собеседовании открывает ?tab=applications&app=12. */
export function launchApp(): number | undefined {
  if (!isWeb) return undefined;
  const id = Number(new URLSearchParams(window.location.search).get('app'));
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
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

export type Located = { lat: number; lon: number } | 'denied' | 'unavailable';

/**
 * Где сейчас телефон: в Telegram 8.0+ через его окно «Разрешить доступ к геопозиции», иначе
 * через браузер. 'denied' — человек не разрешил (в Telegram разрешение меняется в настройках бота),
 * 'unavailable' — телефон не смог определить место.
 */
export async function phoneLocation(): Promise<Located> {
  const app = await initTelegram();
  const manager = supports(app, '8.0') ? app.LocationManager : undefined;
  if (manager) {
    const ready = await new Promise<boolean>((resolve) => {
      if (manager.isInited) return resolve(true);
      const timer = setTimeout(() => resolve(false), 5000);
      manager.init(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (ready && manager.isLocationAvailable) {
      if (manager.isAccessRequested && !manager.isAccessGranted) return 'denied';
      return new Promise((resolve) =>
        manager.getLocation((data) =>
          resolve(data ? { lat: data.latitude, lon: data.longitude } : manager.isAccessGranted ? 'unavailable' : 'denied'),
        ),
      );
    }
  }
  if (!isWeb || !navigator.geolocation) return 'unavailable';
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (err) => resolve(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 60_000 },
    ),
  );
}

/** Настройки бота в Telegram, где включается доступ к геопозиции. false, если открыть нельзя. */
export function openLocationSettings(): boolean {
  const manager = telegram()?.LocationManager;
  if (!supports(telegram(), '8.0') || !manager?.isInited) return false;
  manager.openSettings();
  return true;
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

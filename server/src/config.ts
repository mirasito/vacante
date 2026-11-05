// Настройки сервера из окружения. На сервере их задают systemd-юнит (адреса и папки)
// и файл /etc/vacante/env (токен бота), который пишет выкладка из GitHub Secrets.
import { readFileSync } from "node:fs";

export interface Config {
  botToken: string;
  /** Папка с базой и кружками. */
  dataDir: string;
  /** Папка с файлами кружков (внутри dataDir). */
  videosDir: string;
  host: string;
  port: number;
  /** Адрес API, например https://api.vacante.kz. */
  apiOrigin: string;
  /** Адрес страниц профиля для работодателей, например https://p.vacante.kz. */
  profileOrigin: string;
  /** Откуда приложению можно ходить в API (CORS): сайт, где лежит Mini App. */
  appOrigins: string[];
  siteUrl: string;
  botUsername: string;
  /** Бот на Cloudflare: ему сервер передаёт жалобы на вакансии, у него список модераторов. */
  botUrl: string;
  /** Коммит, из которого собран сервер. */
  version: string;
  /**
   * Можно ли всем создавать профили. Пока юрист не проверил текст согласия, профили
   * создают только тестировщики: они открывают приложение по ссылке t.me/vacantekz_bot?startapp=beta.
   */
  profilesOpen: boolean;
  /**
   * Ключ закладки «Забрать в vacante» для объявлений OLX (server/src/olx-import.ts): sha256("olx:" + пароль
   * админки) в hex, его считает выкладка из секрета ADMIN_PASSWORD. Пусто — импорт выключен.
   */
  olxImportKey: string;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const botToken = env.TELEGRAM_BOT_TOKEN ?? "";
  if (!/^\d+:[\w-]{20,}$/.test(botToken)) {
    throw new Error("Нет TELEGRAM_BOT_TOKEN: без него не проверить вход через Telegram");
  }
  const dataDir = env.DATA_DIR ?? "./data";
  return {
    botToken,
    dataDir,
    videosDir: `${dataDir}/videos`,
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 8080),
    apiOrigin: env.API_ORIGIN ?? "https://api.vacante.kz",
    profileOrigin: env.PROFILE_ORIGIN ?? "https://p.vacante.kz",
    appOrigins: (env.APP_ORIGINS ?? "https://vacante.kz,https://www.vacante.kz")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    siteUrl: env.SITE_URL ?? "https://vacante.kz",
    botUsername: env.BOT_USERNAME ?? "vacantekz_bot",
    botUrl: env.BOT_URL ?? "https://vacante-bot.vacante-kz.workers.dev",
    version: env.VACANTE_VERSION ?? releaseVersion(),
    profilesOpen: env.PROFILES_OPEN === "1",
    olxImportKey: /^[0-9a-f]{64}$/i.test(env.OLX_IMPORT_KEY ?? "") ? (env.OLX_IMPORT_KEY as string).toLowerCase() : "",
  };
}

/** Выкладка кладёт рядом с кодом файл VERSION с номером коммита. */
function releaseVersion(): string {
  try {
    return readFileSync(new URL("../../VERSION", import.meta.url), "utf8").trim() || "dev";
  } catch {
    return "dev";
  }
}

/** Имя хоста из адреса: https://api.vacante.kz → api.vacante.kz. */
export const hostOf = (origin: string) => new URL(origin).host.toLowerCase();

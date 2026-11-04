// Настройки сервера из окружения. На сервере их задают systemd-юнит (адреса и папки)
// и файл /etc/vacante/env (токен бота), который пишет выкладка из GitHub Secrets.
import { readFileSync } from "node:fs";

export interface Config {
  botToken: string;
  /** Папка с базой и кружками. */
  dataDir: string;
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
  /** Коммит, из которого собран сервер. */
  version: string;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const botToken = env.TELEGRAM_BOT_TOKEN ?? "";
  if (!/^\d+:[\w-]{20,}$/.test(botToken)) {
    throw new Error("Нет TELEGRAM_BOT_TOKEN: без него не проверить вход через Telegram");
  }
  return {
    botToken,
    dataDir: env.DATA_DIR ?? "./data",
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
    version: env.VACANTE_VERSION ?? releaseVersion(),
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

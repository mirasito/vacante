// Что бот берёт с сайта: feed.json собирает vacante/site/build.py каждый час.
import { DEFAULT_CHANNELS } from "./employer.js";

/** Свежие вакансии и работающие каналы vacante по городам (город → @канал). Кэш Cloudflare 5 минут. */
export async function siteFeed(env) {
  try {
    const r = await fetch(`${env.SITE_URL}/feed.json`, { cf: { cacheTtl: 300 } });
    return r.ok ? await r.json() : {};
  } catch (err) {
    console.warn(`feed.json: ${err}`);
    return {};
  }
}

/** Каналы, где выходят вакансии городов. Если сайт не ответил, только Астана и Алматы. */
export async function siteChannels(env) {
  const feed = await siteFeed(env);
  return feed.channels && typeof feed.channels === "object" ? feed.channels : DEFAULT_CHANNELS;
}

// Карточки вакансий на проверке у модераторов и пробуждение сборки сайта после решения.
import { dispatchUpdate } from "./cron.js";
import * as job from "./employer.js";
import { edit, screen, send } from "./telegram.js";

// Карточка вакансии модератору; запоминаем сообщение, чтобы потом обновить его после решения
export async function sendNotice(env, chatId, found) {
  const r = await send(env, chatId, ...screen(job.moderationScreen(found)));
  if (r && r.result && r.result.message_id) {
    await env.DB.prepare("INSERT INTO notices (job_id, chat_id, message_id) VALUES (?, ?, ?)")
      .bind(found.id, chatId, r.result.message_id)
      .run();
  }
}

// После решения карточки у всех модераторов показывают, кто и что решил
export async function refreshNotices(env, found) {
  const { results } = await env.DB.prepare("SELECT chat_id, message_id FROM notices WHERE job_id = ?").bind(found.id).all();
  const { text, keyboard } = job.moderationScreen(found);
  for (const n of results) await edit(env, n.chat_id, n.message_id, text, keyboard);
}

export function wakeSite(env, ctx) {
  if (env.GH_DISPATCH_TOKEN) ctx?.waitUntil(dispatchUpdate(env).catch((err) => console.warn(String(err))));
}

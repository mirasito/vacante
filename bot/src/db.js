// Запросы к базе бота D1: подписки, анкеты (dialogs), вакансии, оплаты и отклики.
import * as bot from "./logic.js";

export async function myJobs(env, chatId, limit = 10) {
  const { results } = await env.DB.prepare(
    `SELECT j.*, (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS applications,
       (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.status = 'confirmed') AS confirmed
     FROM jobs j WHERE employer_chat = ? AND status != 'draft' ORDER BY id DESC LIMIT ?`,
  )
    .bind(chatId, limit)
    .all();
  return results;
}

export function getPayment(env, id) {
  return env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first();
}

// Модерация: админы каналов vacante подтверждают себя командой /admin

export async function getApplication(env, id) {
  return env.DB.prepare("SELECT * FROM applications WHERE id = ?").bind(id).first();
}

export function getJob(env, id) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first();
}

export function setDialog(env, chatId, mode, jobId) {
  return env.DB.prepare(
    `INSERT INTO dialogs (chat_id, mode, job_id) VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET mode = excluded.mode, job_id = excluded.job_id`,
  )
    .bind(chatId, mode, jobId)
    .run();
}

export function endDialog(env, chatId) {
  return env.DB.prepare("DELETE FROM dialogs WHERE chat_id = ?").bind(chatId).run();
}

export async function load(env, chatId) {
  const row = await env.DB.prepare("SELECT * FROM subscribers WHERE chat_id = ?").bind(chatId).first();
  return bot.fromRow(row);
}

export async function save(env, chatId, sub) {
  await env.DB.prepare(
    `INSERT INTO subscribers (chat_id, city, categories, perks, min_pay, active) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET city = excluded.city, categories = excluded.categories, perks = excluded.perks,
       min_pay = excluded.min_pay, active = excluded.active, updated_at = datetime('now')`,
  )
    .bind(chatId, ...bot.toRow(sub))
    .run();
}

// Пакеты Про: сколько осталось у работодателя (только непросроченные)
export async function creditsLeft(env, chatId) {
  return (await env.DB.prepare(
    "SELECT COALESCE(SUM(left), 0) AS n FROM credits WHERE employer_chat = ? AND left > 0 AND expires_at > datetime('now')",
  ).bind(chatId).first("n")) || 0;
}

// Списать одну вакансию Про из пакета, который кончается раньше всех. true, если списали.
export async function useCredit(env, chatId) {
  const { meta } = await env.DB.prepare(
    `UPDATE credits SET left = left - 1 WHERE id = (SELECT id FROM credits WHERE employer_chat = ? AND left > 0
       AND expires_at > datetime('now') ORDER BY expires_at LIMIT 1)`,
  ).bind(chatId).run();
  return meta.changes > 0;
}

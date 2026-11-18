// Модерация: /admin для админов каналов, кнопки модераторов, решения агента (/api/moderate) и жалобы из приложения.
import { getJob } from "./db.js";
import * as job from "./employer.js";
import { refreshNotices, sendNotice, wakeSite } from "./notices.js";
import { serverKey } from "./server.js";
import { siteChannels } from "./site.js";
import { answerCallback, edit, screen, send, tg } from "./telegram.js";
import { HELP } from "./texts.js";

export async function becomeAdmin(env, m) {
  const chatId = m.chat.id;
  let isAdmin = false;
  for (const channel of (env.CHANNELS || "").split(",").filter(Boolean)) {
    const member = await tg(env, "getChatMember", { chat_id: channel, user_id: m.from.id });
    if (job.ADMIN_STATUSES.includes(member?.result?.status)) {
      isAdmin = true;
      break;
    }
  }
  if (!isAdmin) return send(env, chatId, HELP);
  await env.DB.prepare("INSERT OR IGNORE INTO admins (chat_id) VALUES (?)").bind(chatId).run();
  const { results } = await env.DB.prepare("SELECT * FROM jobs WHERE status = 'pending' ORDER BY id").all();
  await send(env, chatId, `Готово, вы модератор: вакансии от работодателей будут приходить сюда на проверку. Сейчас ждут: ${results.length}.`);
  for (const pending of results) await sendNotice(env, chatId, pending);
}

export async function moderate(env, q, ctx) {
  const [, verdict, id] = q.data.split(":");
  const admin = await env.DB.prepare("SELECT chat_id FROM admins WHERE chat_id = ?").bind(q.from.id).first();
  const found = admin && (await getJob(env, Number(id)));
  if (!found) return answerCallback(env, q, admin ? "Вакансия не найдена" : "Только для модераторов");
  await answerCallback(env, q);
  const approve = verdict === "ok";
  const who = job.employerName(q.from);
  const { meta } = await env.DB.prepare(
    approve
      ? `UPDATE jobs SET status = 'approved', approved_at = datetime('now'), decided_by = ?, updated_at = datetime('now')
         WHERE id = ? AND status = 'pending'`
      : "UPDATE jobs SET status = 'rejected', decided_by = ?, updated_at = datetime('now') WHERE id = ? AND status = 'pending'",
  )
    .bind(who, found.id)
    .run();
  // Если другой модератор или агент успел раньше, карточка просто покажет их решение
  const now = await getJob(env, found.id);
  await edit(env, q.message.chat.id, q.message.message_id, ...screen(job.moderationScreen(now)));
  if (!meta.changes) return;
  await refreshNotices(env, now);
  await send(env, now.employer_chat, ...(approve ? screen(job.approvedScreen(now, job.boostOffer(env), new Date(), await siteChannels(env), env.SITE_URL)) : [job.rejectedText(now)]));
  // Не ждём часового обновления: сразу запускаем сборку, чтобы вакансия появилась на сайте и в канале за несколько минут
  if (approve) wakeSite(env, ctx);
}

// Агент-модератор: решения из moderate.yml. Каждое решение: {id, verdict: approve|reject|edit, fields, reason}.
// Поля приходят уже оформленными (зарплата, график, адрес, текст); edit только правит поля, не меняя статус.
export async function moderationApi(request, env, ctx) {
  const key = await job.moderationKey(env.TELEGRAM_BOT_TOKEN);
  if (request.headers.get("Authorization") !== `Bearer ${key}`) return new Response("forbidden", { status: 403 });
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.decisions)) return Response.json({ error: "нужен {decisions: [...]}" }, { status: 400 });
  const results = [];
  for (const d of body.decisions) {
    try {
      results.push({ id: d.id, result: await review(env, d) });
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      results.push({ id: d.id, result: "error: сбой бота" });
    }
  }
  if (results.some((r) => r.result === "approved" || r.result === "edited")) wakeSite(env, ctx);
  return Response.json({ results });
}

async function review(env, d) {
  const found = await getJob(env, Number(d.id));
  if (!found) return "error: нет такой вакансии";
  if (found.status !== "pending" && found.status !== "approved") return `skipped: ${job.STATUS[found.status]}`;
  if (!["approve", "reject", "edit"].includes(d.verdict)) return "error: verdict = approve, reject или edit";
  const { job: next, error } = job.reviewFields(found, d.fields);
  if (error) return `error: ${error}`;
  // Уже опубликованную (модератор нажал кнопку сам) агент только оформляет
  const status = found.status === "approved" || d.verdict === "edit" ? found.status : d.verdict === "approve" ? "approved" : "rejected";
  const decided = status !== found.status;
  const { meta } = await env.DB.prepare(
    `UPDATE jobs SET status = ?, title = ?, company = ?, salary = ?, schedule = ?, address = ?, details = ?,
       salary_min = ?, salary_max = ?, salary_period = ?, reviewed_at = datetime('now'),
       decided_by = CASE WHEN ? THEN 'агент' ELSE decided_by END,
       approved_at = CASE WHEN ? = 'approved' AND approved_at IS NULL THEN datetime('now') ELSE approved_at END,
       updated_at = datetime('now')
     WHERE id = ? AND status = ?`,
  )
    .bind(status, next.title, next.company, next.salary, next.schedule, next.address, next.details,
      next.salary_min ?? null, next.salary_max ?? null, next.salary_period ?? null, decided ? 1 : 0, status, found.id, found.status)
    .run();
  if (!meta.changes) return "skipped: вакансию только что изменили";
  const saved = await getJob(env, found.id);
  await refreshNotices(env, saved);
  if (!decided) return "edited";
  await send(env, saved.employer_chat,
    ...(status === "approved" ? screen(job.approvedScreen(saved, job.boostOffer(env), new Date(), await siteChannels(env), env.SITE_URL)) : [job.rejectedText(saved, d.reason)]));
  return status;
}

// Кандидат: отклик по ссылке t.me/vacantekz_bot?start=apply_<id> с сайта или из канала

const REPORT_REASONS = {
  fraud: "мошенничество",
  prepay: "просят предоплату",
  contacts: "не отвечают по контактам",
  closed: "вакансия уже закрыта",
  wrong: "неверные данные",
  other: "другое",
};

// Жалоба соискателя на вакансию: сервер проверил вход через Telegram и передаёт её сюда, а бот
// пишет всем модераторам. Имя жалобщика не передаём, только его номер в Telegram для связи
export async function reportApi(request, env) {
  if (request.headers.get("authorization") !== `Bearer ${await serverKey(env.TELEGRAM_BOT_TOKEN)}`) {
    return new Response("forbidden", { status: 403 });
  }
  const r = await request.json().catch(() => ({}));
  const esc = (v) => String(v ?? "").slice(0, 500).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = [
    `🚩 Жалоба на вакансию: ${esc(REPORT_REASONS[r.reason] ?? REPORT_REASONS.other)}`,
    `<b>${esc(r.title) || esc(r.vacancy_id)}</b>${r.employer ? ` · ${esc(r.employer)}` : ""}`,
  ];
  if (r.text) lines.push(`«${esc(r.text)}»`);
  if (r.url) lines.push(esc(r.url));
  lines.push(`id: ${esc(r.vacancy_id)} · от tg://user?id=${Number(r.from) || 0}`);
  const { results } = await env.DB.prepare("SELECT chat_id FROM admins").all();
  for (const admin of results) await send(env, admin.chat_id, lines.join("\n"));
  return Response.json({ ok: true, sent: results.length });
}

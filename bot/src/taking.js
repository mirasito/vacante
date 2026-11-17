// Смены на день: «Беру смену», решение работодателя, отметка «кто пришёл», подписка на смены и будильник.
import { endDialog, getApplication, getJob, load, save, setDialog } from "./db.js";
import * as job from "./employer.js";
import * as bot from "./logic.js";
import { wakeSite } from "./notices.js";
import * as shift from "./shift.js";
import { answerCallback, edit, screen, send, tg } from "./telegram.js";
import { NO_KEYBOARD } from "./texts.js";

const SHIFT_GONE = "Эта смена уже закрыта или набрана. Другие смены и подработка: /smeny";

function shiftOpen(found, now = new Date()) {
  return found && found.kind === "shift" && found.status === "approved" && shift.shiftTimes(found).start > now;
}

// Надёжность соискателя: сколько смен отметили и на скольких он был
async function reliabilityOf(env, chatId) {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS total, COALESCE(SUM(attended), 0) AS came FROM applications WHERE chat_id = ? AND attended IS NOT NULL",
  )
    .bind(chatId)
    .first();
  return { total: Number(r.total), came: Number(r.came) };
}

export async function startTake(env, m, id) {
  const chatId = m.chat.id;
  const found = id ? await getJob(env, id) : null;
  if (!shiftOpen(found)) return send(env, chatId, SHIFT_GONE);
  if (found.employer_chat === chatId) return send(env, chatId, "Это ваша смена. Просьбы кандидатов придут сюда, список: /myjobs");
  const mine = await env.DB.prepare("SELECT status FROM applications WHERE job_id = ? AND chat_id = ? AND status != 'cancelled'")
    .bind(id, chatId)
    .first();
  if (mine && mine.status === "confirmed") return send(env, chatId, "Вас уже ждут на этой смене. Если не сможете прийти, нажмите «Не смогу прийти» в сообщении о подтверждении.");
  if (mine) return send(env, chatId, "Вы уже попросились на эту смену. Работодатель ответит здесь, обычно в течение пары часов.");
  await setDialog(env, chatId, "take", id);
  return send(env, chatId, shift.takeIntro(found), job.CONTACT_KEYBOARD);
}

export async function takeAnswer(env, m, d) {
  const chatId = m.chat.id;
  const phone = m.contact ? m.contact.phone_number : null;
  if (!m.text && !phone) return send(env, chatId, "Отправьте номер кнопкой внизу или напишите о себе текстом.");
  await endDialog(env, chatId);
  const found = await getJob(env, d.job_id);
  if (!shiftOpen(found)) return send(env, chatId, SHIFT_GONE, NO_KEYBOARD);
  const { meta } = await env.DB.prepare("INSERT INTO applications (job_id, chat_id, status, name) VALUES (?, ?, 'asked', ?)")
    .bind(found.id, chatId, [m.from.first_name, m.from.last_name].filter(Boolean).join(" ").slice(0, 60))
    .run();
  const rel = await reliabilityOf(env, chatId);
  await send(env, found.employer_chat, ...screen(shift.takeRequest(found, { id: meta.last_row_id }, m.from, m.text, phone, rel)));
  return send(
    env,
    chatId,
    "✅ Попросились на смену. Работодатель подтвердит здесь, обычно в течение пары часов.\n\nПрисылать новые смены и подработку: /smeny",
    NO_KEYBOARD,
  );
}

async function confirmedCount(env, jobId) {
  return Number(await env.DB.prepare("SELECT COUNT(*) AS n FROM applications WHERE job_id = ? AND status = 'confirmed'").bind(jobId).first("n"));
}

// Кнопки «✅ Беру / Не подходит» у работодателя и «Не смогу прийти» у соискателя
export async function shiftDecision(env, q, ctx) {
  const [, verdict, id] = q.data.split(":");
  const chatId = q.message.chat.id;
  const a = await getApplication(env, Number(id));
  const found = a && (await getJob(env, a.job_id));
  if (!found) return answerCallback(env, q, "Смена не найдена");
  if (verdict === "cancel") {
    if (a.chat_id !== chatId) return answerCallback(env, q);
    const { meta } = await env.DB.prepare("UPDATE applications SET status = 'cancelled' WHERE id = ? AND status = 'confirmed'").bind(a.id).run();
    await answerCallback(env, q, meta.changes ? "Предупредили работодателя" : undefined);
    if (!meta.changes) return;
    await edit(env, chatId, q.message.message_id, "Отменили: работодатель знает, что вы не придёте. Другие смены: /smeny");
    // Набранная смена снова открывается, если до неё ещё есть время
    if (found.status === "closed" && found.closed_full && shift.shiftTimes(found).start > new Date()) {
      await env.DB.prepare("UPDATE jobs SET status = 'approved', closed_full = 0, updated_at = datetime('now') WHERE id = ?").bind(found.id).run();
      wakeSite(env, ctx);
    }
    return send(env, found.employer_chat, shift.cancelledText(found, q.from));
  }
  if (found.employer_chat !== chatId) return answerCallback(env, q);
  const ok = verdict === "ok";
  if (ok && found.need && (await confirmedCount(env, found.id)) >= found.need) {
    return answerCallback(env, q, `Уже набрали ${found.need} ${shift.people(found.need)}`);
  }
  const { meta } = await env.DB.prepare("UPDATE applications SET status = ? WHERE id = ? AND status = 'asked'")
    .bind(ok ? "confirmed" : "declined", a.id)
    .run();
  await answerCallback(env, q);
  const now = await getApplication(env, a.id);
  const text = `${q.message.text || ""}\n\n${shift.decidedLine(now.status)}`.trim();
  await tg(env, "editMessageText", { chat_id: chatId, message_id: q.message.message_id, text, disable_web_page_preview: true });
  if (!meta.changes) return;
  if (!ok) return send(env, a.chat_id, shift.declinedText(found, env.SITE_URL));
  await send(env, a.chat_id, shift.confirmedText(found, job.BOT_USERNAME).text, shift.cancelButton(a));
  // Набрали всех: смена уходит с сайта, остальным просящим вежливо отвечаем
  if (found.need && (await confirmedCount(env, found.id)) >= found.need && found.status === "approved") {
    await env.DB.prepare("UPDATE jobs SET status = 'closed', closed_full = 1, updated_at = datetime('now') WHERE id = ?").bind(found.id).run();
    await send(env, found.employer_chat, shift.fullText(found));
    wakeSite(env, ctx);
  }
}

// Отметка «пришёл / не пришёл» после смены
export async function attendance(env, q) {
  const [, value, id] = q.data.split(":");
  if (value === "done") return answerCallback(env, q, "Уже отмечено");
  const a = await getApplication(env, Number(id));
  const found = a && (await getJob(env, a.job_id));
  if (!found || found.employer_chat !== q.message.chat.id) return answerCallback(env, q);
  const { meta } = await env.DB.prepare("UPDATE applications SET attended = ? WHERE id = ? AND status = 'confirmed' AND attended IS NULL")
    .bind(value === "1" ? 1 : 0, a.id)
    .run();
  await answerCallback(env, q);
  const { results } = await env.DB.prepare("SELECT id, name, attended FROM applications WHERE job_id = ? AND status = 'confirmed' ORDER BY id")
    .bind(found.id)
    .all();
  await edit(env, q.message.chat.id, q.message.message_id, ...screen(shift.attendanceScreen(found, results)));
  if (meta.changes && value === "1") await send(env, a.chat_id, shift.attendedText(found, await reliabilityOf(env, a.chat_id)));
}

// /smeny: подписка на смены и подработку в своём городе
export async function subscribeShifts(env, chatId) {
  const sub = await load(env, chatId);
  const next = { ...sub, perks: sub.perks.includes(bot.SHIFT) ? sub.perks : [...sub.perks, bot.SHIFT] };
  if (!next.city) {
    await save(env, chatId, { ...next, active: 0 });
    return send(env, chatId, "⚡ Буду присылать смены и подработку. Где ищете?", bot.screen("city", next).keyboard);
  }
  await save(env, chatId, { ...next, active: 1 });
  return send(
    env,
    chatId,
    `⚡ Готово: присылаю смены и подработку (${bot.summary(next)}).\n\nВсе смены сейчас: ${env.SITE_URL}/${next.city}/smeny/\nИзменить: /settings`,
  );
}

// Будильник раз в час: напоминание за несколько часов до смены, после смены вопрос «кто пришёл»,
// закрытие прошедших смен (с сайта они уходят при следующем обновлении)
export async function shiftCron(env, now = new Date()) {
  const { results: jobs } = await env.DB.prepare(
    "SELECT * FROM jobs WHERE kind = 'shift' AND status IN ('approved', 'closed') AND attendance_asked = 0 AND shift_date >= ?",
  )
    .bind(shift.localDay(now, -2))
    .all();
  for (const j of jobs) {
    const { start, end } = shift.shiftTimes(j);
    const { results: apps } = await env.DB.prepare("SELECT * FROM applications WHERE job_id = ? AND status = 'confirmed' ORDER BY id")
      .bind(j.id)
      .all();
    if (start > now && start - now <= shift.REMIND_HOURS * 3600e3) {
      for (const a of apps.filter((x) => !x.reminded)) {
        await env.DB.prepare("UPDATE applications SET reminded = 1 WHERE id = ?").bind(a.id).run();
        await send(env, a.chat_id, shift.remindText(j, now), shift.cancelButton(a));
      }
    }
    if (start <= now && j.status === "approved") {
      await env.DB.prepare("UPDATE jobs SET status = 'closed', updated_at = datetime('now') WHERE id = ?").bind(j.id).run();
      // Кто попросился, но не дождался ответа
      await env.DB.prepare("UPDATE applications SET status = 'declined' WHERE job_id = ? AND status = 'asked'").bind(j.id).run();
    }
    if (end <= now) {
      await env.DB.prepare("UPDATE jobs SET attendance_asked = 1 WHERE id = ?").bind(j.id).run();
      if (apps.length) await send(env, j.employer_chat, ...screen(shift.attendanceScreen(j, apps, now)));
    }
  }
}

// База и Telegram

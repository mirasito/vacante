// Отклик кандидата на вакансию в боте.
import { endDialog, getJob, setDialog } from "./db.js";
import * as job from "./employer.js";
import * as shift from "./shift.js";
import { startTake } from "./taking.js";
import { send } from "./telegram.js";
import { JOB_CLOSED, NO_KEYBOARD } from "./texts.js";

export async function startApply(env, m, id) {
  const chatId = m.chat.id;
  const found = id ? await getJob(env, id) : null;
  if (found && found.kind === "shift") return startTake(env, m, id);
  if (!found || found.status !== "approved") return send(env, chatId, JOB_CLOSED);
  const applied = await env.DB.prepare("SELECT id FROM applications WHERE job_id = ? AND chat_id = ?").bind(id, chatId).first();
  if (applied) return send(env, chatId, "Вы уже откликнулись на эту вакансию, работодатель получил отклик и свяжется с вами сам.");
  await setDialog(env, chatId, "apply", id);
  return send(env, chatId, job.applyIntro(found), job.CONTACT_KEYBOARD);
}

export async function applyAnswer(env, m, d) {
  const chatId = m.chat.id;
  const phone = m.contact ? m.contact.phone_number : null;
  if (!m.text && !phone) return send(env, chatId, "Напишите о себе текстом или отправьте номер кнопкой внизу.");
  await endDialog(env, chatId);
  const found = await getJob(env, d.job_id);
  if (!found || found.status !== "approved") return send(env, chatId, JOB_CLOSED, NO_KEYBOARD);
  // Номер сообщения с откликом у работодателя: по кнопке «📩 Отклики» бот покажет его ещё раз (copyMessage).
  // Сам текст отклика и номер кандидата бот не хранит.
  const sent = await send(env, found.employer_chat, job.applicationText(found, m.from, m.text, phone));
  await env.DB.prepare("INSERT INTO applications (job_id, chat_id, notice_id) VALUES (?, ?, ?)")
    .bind(found.id, chatId, sent?.result?.message_id ?? null).run();
  return send(
    env,
    chatId,
    "✅ Отклик отправлен работодателю, он свяжется с вами сам.\n\nХотите получать новые вакансии по своему городу? /start",
    NO_KEYBOARD,
  );
}

// Смены (shift.js): «Беру смену» по ссылке t.me/vacantekz_bot?start=take_<id> с сайта, из приложения или канала

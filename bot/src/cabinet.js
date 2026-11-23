// Кабинет работодателя в приложении (Mini App vacante.kz/app/?tab=employer). Приложение входит данными
// Telegram (initData), бот проверяет их подписью своего токена, как сервер профилей (server/src/telegram.ts).
// На сайте вне Telegram вход через бота (login.js): заголовок Authorization: session <ключ>.
// Вакансии работодателя живут здесь, в D1 бота, поэтому кабинет ходит прямо в воркер:
//   GET  /api/cabinet   — вакансии, отклики, тарифы, остаток пакетов, реквизиты Kaspi
//   POST /api/cabinet   — { action, id?, count? }: close, apps, credit, paid_boost, paid_post, paid_pack,
//                         а форма размещения на сайте: save { fields } (черновик) и submit { fields, tariff } (webpost.js)
// Отклики бот не хранит (только номера сообщений), поэтому «Отклики» присылает их ещё раз в чат с ботом.
import options from "./options.json" with { type: "json" };
import { creditsLeft, myJobs } from "./db.js";
import * as job from "./employer.js";
import { verifySession } from "./login.js";
import { boostWithCredit, requestBoost, requestPack, requestPost } from "./payments.js";
import { closeOwnJob, pasteFromApp, resendApplications } from "./posting.js";
import { send } from "./telegram.js";
import { currentDraft, draftView, saveDraft, submitForm } from "./webpost.js";

const CITY = Object.fromEntries(options.cities);
export const INIT_DATA_MAX_AGE = 24 * 60 * 60;
const ORIGINS = ["https://vacante.kz", "https://www.vacante.kz"];
const MAX_JOBS = 30;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(key, text) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text));
}

/** Пользователь Telegram из initData или null, если подпись не сошлась или данные устарели. */
export async function verifyInitData(raw, token, nowMs = Date.now()) {
  const params = new URLSearchParams(raw || "");
  const hash = params.get("hash") || "";
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const secret = await hmac(new TextEncoder().encode("WebAppData"), token);
  let signed = false;
  // Поле signature (Bot API 8.0) входит в подписанную строку; без него тоже пробуем, как на сервере
  for (const skip of [["hash"], ["hash", "signature"]]) {
    const check = [...params.entries()].filter(([key]) => !skip.includes(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => `${key}=${value}`).join("\n");
    if (hex(await hmac(secret, check)) === hash) signed = true;
  }
  if (!signed) return null;
  const age = nowMs / 1000 - Number(params.get("auth_date"));
  if (!Number.isFinite(age) || age > INIT_DATA_MAX_AGE || age < -300) return null;
  try {
    const user = JSON.parse(params.get("user") || "");
    return user && Number.isSafeInteger(user.id) && user.id > 0 ? user : null;
  } catch {
    return null;
  }
}

export function cors(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = [...ORIGINS, ...String(env.APP_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean)];
  return allowed.includes(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Max-Age": "86400", Vary: "Origin" }
    : {};
}

/** Что видит работодатель в кабинете. */
export async function cabinetState(env, user, now = new Date()) {
  const chatId = user.id;
  const boost = job.boostOffer(env);
  const admin = !!(await env.DB.prepare("SELECT chat_id FROM admins WHERE chat_id = ?").bind(chatId).first());
  const { results: waiting } = await env.DB.prepare(
    "SELECT job_id, kind FROM payments WHERE employer_chat = ? AND status = 'pending'",
  ).bind(chatId).all();
  const jobs = (await myJobs(env, chatId, MAX_JOBS)).map((j) => {
    const offer = boost && job.offerFor(boost, j, now);
    return {
      id: j.id,
      kind: j.kind === "shift" ? "shift" : "vacancy",
      title: j.title,
      company: j.company,
      city: CITY[j.city] || "",
      salary: j.salary,
      status: j.status,
      status_text: job.STATUS[j.status],
      applications: j.applications,
      confirmed: j.kind === "shift" ? j.confirmed : undefined,
      need: j.kind === "shift" ? j.need : undefined,
      shift_date: j.shift_date || undefined,
      pro_until: job.isBoosted(j, now) ? job.localDate(j.boost_until) : null,
      url: j.status === "approved" ? job.jobUrl(j, env.SITE_URL) : null,
      // Ждёт оплаты размещения: сумма и комментарий к переводу
      pay: j.status === "payment" && boost ? { amount: job.postPriceFor(j, boost, now), tariff: j.pro ? "pro" : "basic",
        waiting: waiting.some((p) => p.job_id === j.id && p.kind === "post") } : null,
      // Можно поднять по Про: цена, срок, ждём ли перевод
      boost: j.status === "approved" && offer ? { price: offer.price, days: offer.days, shift: !!offer.shift, active: job.isBoosted(j, now),
        waiting: waiting.some((p) => p.job_id === j.id && p.kind !== "post") } : null,
    };
  });
  return {
    user: { id: chatId, first_name: user.first_name || "" },
    admin,
    jobs,
    credits: await creditsLeft(env, chatId),
    kaspi: boost ? boost.kaspi : null,
    // Модератор видит тарифы, как все: бесплатно он размещает только кнопкой «Без оплаты»
    tariffs: boost && job.postPrice(boost) ? { post: job.postPrice(boost), pro: boost.price, days: boost.days, shift_pro: boost.shiftPrice,
      packs: boost.packs } : null,
    pack_waiting: waiting.some((p) => p.kind === "pack"),
    draft: draftView(await currentDraft(env, chatId)),
    bot: job.BOT_USERNAME,
  };
}

// Действия кабинета. Бот дублирует их сообщением в чат, чтобы у работодателя оставалась история.
async function act(env, user, body, ctx) {
  const chatId = user.id;
  const id = Number(body.id);
  switch (body.action) {
    case "close":
      return (await closeOwnJob(env, chatId, id)) ? { message: "Вакансия закрыта, с сайта она уйдёт в течение часа" }
        : { error: "Эту вакансию уже нельзя закрыть" };
    case "apps": {
      const r = await resendApplications(env, chatId, id);
      if (r.error) return r;
      return { message: r.total ? "Отклики отправили вам в чат с ботом" : "Откликов пока нет" };
    }
    case "credit": {
      const r = await boostWithCredit(env, chatId, id, ctx);
      if (r.error) return r;
      await send(env, chatId, `${job.boostedText(r.job)}\n\nОсталось Про в пакетах: ${r.left}.`);
      return { message: `Тариф Про включён до ${job.localDate(r.job.boost_until)}` };
    }
    case "paid_boost": {
      const r = await requestBoost(env, chatId, id);
      if (r.error) return r;
      await send(env, chatId, job.paymentWaitText(r.job));
      return { message: "Сверяем перевод, обычно это до пары часов днём. Напишем в чат с ботом" };
    }
    case "paid_post": {
      const r = await requestPost(env, chatId, id);
      if (r.error) return r;
      await send(env, chatId, job.postWaitText(r.job));
      return { message: "Сверяем перевод, потом вакансия уйдёт на проверку. Напишем в чат с ботом" };
    }
    case "paid_pack": {
      const r = await requestPack(env, chatId, body.count, user);
      if (r.error) return r;
      await send(env, chatId, job.packWaitText(r.pack));
      return { message: "Сверяем перевод за пакет. Напишем в чат с ботом, как только включим" };
    }
    case "save": {
      const r = await saveDraft(env, user, body.fields || {}, body.from);
      return r.error ? r : { message: "" };
    }
    case "submit":
      return submitForm(env, user, body.fields || {}, body.tariff, body.from, ctx);
    case "paste": {
      // Быстрое размещение: текст или ссылка из кабинета, анкета продолжается в чате с ботом
      const text = String(body.text ?? "").trim().slice(0, 4000);
      if (text.length < 20) return { error: "Вставьте текст вакансии целиком или ссылку на неё" };
      return pasteFromApp(env, user, text);
    }
    default:
      return { error: "Неизвестное действие" };
  }
}

export async function cabinetApi(request, env, ctx) {
  const headers = cors(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const auth = request.headers.get("Authorization") || "";
  const user = /^session\s+/.test(auth) ? await verifySession(auth.replace(/^session\s+/, ""), env.TELEGRAM_BOT_TOKEN)
    : await verifyInitData(auth.replace(/^tma\s+/, ""), env.TELEGRAM_BOT_TOKEN);
  if (!user) return Response.json({ error: "Откройте кабинет из Telegram" }, { status: 401, headers });
  if (request.method === "GET") return Response.json(await cabinetState(env, user), { headers });
  if (request.method !== "POST") return Response.json({ error: "method" }, { status: 405, headers });
  const body = await request.json().catch(() => ({}));
  const result = await act(env, user, body, ctx);
  return Response.json({ ...result, state: await cabinetState(env, user) }, { status: result.error ? 400 : 200, headers });
}

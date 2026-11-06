// Профиль работодателя в боте: /company. Работодатель видит свою компанию и её заведения, добавляет
// заведения, находит свою компанию («Это моя компания», подтверждение в админке) и выбирает, для какого
// заведения его вакансия из бота. Всё хранится в CRM работодателей (server/src/crm.ts).
//
// Бот на Cloudflare передаёт сюда /company, кнопки «c:…» и ответы на два наших вопроса с принудительным
// ответом: «🏠 Новое заведение» и «🔎 Поиск компании» (bot/src/index.js).
import type { Ctx } from "./app.ts";
import { addVenue, employerView, getEmployer, logActivity, nameKey, venueView } from "./crm.ts";
import type { TgCallback, TgMessage } from "./internal.ts";
import { CITY_SLUGS, cityName } from "./labels.ts";

export const COMPANY = /^\/company(@\w+)?$/;
export const ADD_MARK = "🏠 Новое заведение";
export const SEARCH_MARK = "🔎 Поиск компании";
const STATE_HOURS = 24;
const VENUE_BUTTONS = 8;

export interface CrmBot {
  onMessage(m: TgMessage & { from: NonNullable<TgMessage["from"]> }): Promise<boolean>;
  onCallback(q: TgCallback): Promise<boolean>;
  /** После часового импорта: поздравить новых владельцев профиля и спросить, для какого заведения вакансия. */
  afterImport(greet: { chat: number; employerId: number }[], jobs: number[]): Promise<void>;
  venueReviewed(venueId: number, approved: boolean): Promise<void>;
  memberDecided(memberId: number, confirmed: boolean): Promise<void>;
}

type Keyboard = { text: string; callback_data: string }[][];

export function createCrmBot(ctx: Ctx): CrmBot {
  const db = ctx.db;
  const nowIso = () => new Date(ctx.now()).toISOString();
  const call = async (method: string, body: Record<string, unknown>) => {
    try {
      await ctx.bot.call(method, body);
    } catch (err) {
      console.warn(`${method}: ${err instanceof Error ? err.message : err}`);
    }
  };
  const send = (chat: number, text: string, keyboard?: Keyboard) =>
    call("sendMessage", { chat_id: chat, text, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) });
  const ask = (chat: number, text: string, placeholder: string) =>
    call("sendMessage", { chat_id: chat, text, reply_markup: { force_reply: true, input_field_placeholder: placeholder } });
  const answer = (q: TgCallback, text?: string) => call("answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text } : {}) });

  const confirmedOf = (chat: number) =>
    db.prepare("SELECT employer_id FROM members WHERE tg_chat = ? AND confirmed_at IS NOT NULL ORDER BY confirmed_at")
      .all(chat) as { employer_id: number }[];
  const isMember = (chat: number, employerId: number) =>
    !!db.prepare("SELECT 1 FROM members WHERE tg_chat = ? AND employer_id = ? AND confirmed_at IS NOT NULL").get(chat, employerId);
  const nameOf = (employerId: number) => {
    const e = getEmployer(db, employerId);
    return e ? employerView(e).name : "компания";
  };
  const venuesOf = (employerId: number) =>
    (db.prepare("SELECT * FROM venues WHERE employer_id = ? AND removed = 0 AND review != 'rejected' ORDER BY city, name")
      .all(employerId) as Record<string, unknown>[]).map(venueView);

  function setState(chat: number, fields: { employer_id?: number | null; city?: string | null; query?: string | null }) {
    db.prepare(
      `INSERT INTO crm_bot_state (tg_chat, employer_id, city, query, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tg_chat) DO UPDATE SET employer_id = excluded.employer_id, city = excluded.city, query = excluded.query, at = excluded.at`,
    ).run(chat, fields.employer_id ?? null, fields.city ?? null, fields.query ?? null, nowIso());
  }
  function getState(chat: number) {
    const s = db.prepare("SELECT * FROM crm_bot_state WHERE tg_chat = ?").get(chat) as
      { employer_id: number | null; city: string | null; query: string | null; at: string } | undefined;
    return s && Date.parse(s.at) > ctx.now() - STATE_HOURS * 3600_000 ? s : null;
  }

  function companyScreen(employerId: number): [string, Keyboard] {
    const venues = venuesOf(employerId);
    const active = (db.prepare(
      `SELECT count(*) AS n FROM employer_vacancies x JOIN venues v ON v.id = x.venue_id WHERE v.employer_id = ? AND x.active = 1`,
    ).get(employerId) as { n: number }).n;
    const lines = venues.map((v, i) => {
      const place = [v.city ? cityName(v.city, "ru") : null, v.address].filter(Boolean).join(", ");
      return `${i + 1}. ${v.name}${place ? ` — ${place}` : ""}${v.review === "pending" ? " (на проверке)" : ""}`;
    });
    const text = [
      `🏢 ${nameOf(employerId)}`,
      "",
      venues.length ? `Заведения:\n${lines.join("\n")}` : "Заведений пока нет. Добавьте их, чтобы кандидаты видели, где работать.",
      "",
      `Вакансий на vacante.kz сейчас: ${active}.`,
      "Разместить вакансию: /vacancy, найти людей на смену: /smena, ваши вакансии: /myjobs",
    ].join("\n");
    return [text, [[{ text: "➕ Добавить заведение", callback_data: `c:add:${employerId}` }]]];
  }

  async function show(chat: number) {
    const own = confirmedOf(chat);
    if (own.length === 1) return send(chat, ...companyScreen(own[0]!.employer_id));
    if (own.length > 1) {
      return send(chat, "Какую компанию открыть?", own.map((o) => [{ text: nameOf(o.employer_id), callback_data: `c:e:${o.employer_id}` }]));
    }
    const pending = db.prepare(
      "SELECT employer_id FROM members WHERE tg_chat = ? AND confirmed_at IS NULL AND rejected_at IS NULL",
    ).all(chat) as { employer_id: number }[];
    if (pending.length) {
      return send(chat, `Заявка на профиль «${nameOf(pending[0]!.employer_id)}» на проверке. Напишу, как только подтвердим.`);
    }
    await send(chat, "Профиль компании в vacante: ваши заведения, вакансии и смены в одном месте.\n\nСначала найдём вашу компанию.");
    return ask(chat, `${SEARCH_MARK}\nОтветьте на это сообщение названием вашей компании, как в ваших вакансиях.`, "Название компании");
  }

  async function search(chat: number, query: string) {
    const key = nameKey(query);
    if (key.length < 2) return ask(chat, `${SEARCH_MARK}\nНапишите название чуть подробнее.`, "Название компании");
    const rows = db.prepare(
      `SELECT e.id, e.name, e.edits, (SELECT count(*) FROM employer_vacancies x JOIN venues v ON v.id = x.venue_id
         WHERE v.employer_id = e.id AND x.active = 1) AS active FROM employers e`,
    ).all() as Record<string, unknown>[];
    const found = rows
      .map((r) => ({ id: r.id as number, name: employerView(r).name, active: r.active as number }))
      .filter((r) => nameKey(r.name).includes(key))
      .sort((a, b) => Number(nameKey(b.name) === key) - Number(nameKey(a.name) === key) || b.active - a.active)
      .slice(0, 6);
    setState(chat, { query: query.slice(0, 120) });
    const keyboard: Keyboard = found.map((r) => [{ text: `${r.name}${r.active ? ` · ${r.active} вак.` : ""}`.slice(0, 60), callback_data: `c:cl:${r.id}` }]);
    keyboard.push([{ text: `Моей компании нет, создать «${query.slice(0, 30)}»`, callback_data: "c:nw" }]);
    return send(chat, found.length ? "Это ваша компания?" : "Такой компании у нас пока нет.", keyboard);
  }

  async function addFromReply(chat: number, text: string) {
    const state = getState(chat);
    if (!state?.employer_id || !isMember(chat, state.employer_id)) {
      await send(chat, "Не понял, к какой компании добавить заведение. Откройте /company и нажмите «Добавить заведение».");
      return;
    }
    const insta = /(?:instagram\.com\/|@)([a-z0-9._]{2,30})/i.exec(text);
    const rest = text.replace(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/[a-z0-9._]+\/?|@[a-z0-9._]+/gi, "").trim();
    const [name, ...address] = rest.split(",").map((s) => s.trim()).filter(Boolean);
    if (!name) {
      await ask(chat, `${ADD_MARK} · ${cityName(state.city ?? "", "ru")}\nНапишите название и адрес через запятую.`, "Название, адрес");
      return;
    }
    addVenue(db, state.employer_id, { name, address: address.join(", "), city: state.city, instagram: insta?.[1] }, nowIso(), "employer");
    db.prepare("DELETE FROM crm_bot_state WHERE tg_chat = ?").run(chat);
    await send(chat, `✅ Заведение «${name}» добавлено. Проверим его, обычно в течение дня, и напишу.\n\nПрофиль компании: /company`);
  }

  return {
    async onMessage(m) {
      const text = m.text?.trim() ?? "";
      const chat = m.chat.id;
      if (COMPANY.test(text)) {
        await show(chat);
        return true;
      }
      const asked = m.reply_to_message?.text ?? "";
      if (asked.startsWith(ADD_MARK) && text) {
        await addFromReply(chat, text);
        return true;
      }
      if (asked.startsWith(SEARCH_MARK) && text) {
        await search(chat, text);
        return true;
      }
      return false;
    },

    async onCallback(q) {
      const data = q.data ?? "";
      if (!data.startsWith("c:") || !q.message) return false;
      const chat = q.message.chat.id;
      const [, action, a, b] = data.split(":");
      const id = Number(a);
      const at = nowIso();
      if (action === "e" && isMember(chat, id)) {
        await answer(q);
        await send(chat, ...companyScreen(id));
      } else if (action === "add" && isMember(chat, id)) {
        await answer(q);
        const rows: Keyboard = [];
        for (let i = 0; i < CITY_SLUGS.length; i += 3) {
          rows.push(CITY_SLUGS.slice(i, i + 3).map((slug) => ({ text: cityName(slug, "ru"), callback_data: `c:ac:${id}:${slug}` })));
        }
        await send(chat, "В каком городе заведение?", rows);
      } else if (action === "ac" && isMember(chat, id) && b && CITY_SLUGS.includes(b)) {
        await answer(q);
        setState(chat, { employer_id: id, city: b });
        await ask(chat,
          `${ADD_MARK} · ${cityName(b, "ru")}\nОтветьте на это сообщение: название и адрес через запятую. Можно добавить Instagram заведения.\n\nНапример: Greenwich, пр. Достык 111, @greenwich.kz`,
          "Название, адрес");
      } else if (action === "cl" && getEmployer(db, id)) {
        const exists = db.prepare("SELECT confirmed_at, rejected_at FROM members WHERE employer_id = ? AND tg_chat = ?").get(id, chat) as
          { confirmed_at: string | null; rejected_at: string | null } | undefined;
        await answer(q);
        if (exists?.confirmed_at) return (await send(chat, ...companyScreen(id)), true);
        if (!exists) {
          const name = [q.from.first_name, q.from.username ? `@${q.from.username}` : null].filter(Boolean).join(" ");
          db.prepare("INSERT INTO members (employer_id, tg_chat, name, claimed_at) VALUES (?, ?, ?, ?)").run(id, chat, name, at);
          logActivity(db, id, "member", `Заявка «Это моя компания» от ${name}`, at, "employer");
        }
        await send(chat, `Заявка отправлена. Проверим, что вы из «${nameOf(id)}», обычно в течение дня, и напишу.`);
      } else if (action === "nw") {
        const query = getState(chat)?.query;
        await answer(q);
        if (!query) return (await show(chat), true);
        const key = nameKey(query);
        const existing = db.prepare("SELECT id FROM employers WHERE key = ?").get(key) as { id: number } | undefined;
        if (existing) {
          await send(chat, `«${nameOf(existing.id)}» у нас уже есть. Это ваша компания?`, [[{ text: "Да, моя", callback_data: `c:cl:${existing.id}` }]]);
          return true;
        }
        const row = db.prepare("INSERT INTO employers (key, name, first_seen, last_seen) VALUES (?, ?, ?, ?) RETURNING id")
          .get(key, query, at, at) as { id: number };
        db.prepare("INSERT INTO members (employer_id, tg_chat, name, claimed_at, confirmed_at) VALUES (?, ?, ?, ?, ?)")
          .run(row.id, chat, q.from.first_name, at, at);
        logActivity(db, row.id, "member", `Работодатель создал профиль в боте: ${q.from.first_name}`, at, "employer");
        db.prepare("DELETE FROM crm_bot_state WHERE tg_chat = ?").run(chat);
        await send(chat, ...companyScreen(row.id));
      } else if (action === "jv") {
        const jobId = id, venueId = Number(b);
        const job = db.prepare("SELECT tg_chat, employer_id FROM bot_jobs WHERE job_id = ?").get(jobId) as
          { tg_chat: number; employer_id: number | null } | undefined;
        const venue = db.prepare("SELECT * FROM venues WHERE id = ? AND removed = 0").get(venueId) as Record<string, unknown> | undefined;
        if (!job || job.tg_chat !== chat || !venue || venue.employer_id !== job.employer_id) {
          await answer(q, "Эта кнопка уже не работает");
          return true;
        }
        db.prepare("UPDATE bot_jobs SET venue_id = ? WHERE job_id = ?").run(venueId, jobId);
        db.prepare("UPDATE employer_vacancies SET venue_id = ? WHERE id = ?").run(venueId, `bot-${jobId}`);
        await answer(q, "Сохранил");
        await call("editMessageText", { chat_id: chat, message_id: q.message.message_id, text: `✅ Вакансия №${jobId}: ${venueView(venue).name}` });
      } else {
        await answer(q, "Эта кнопка уже не работает");
      }
      return true;
    },

    async afterImport(greet, jobs) {
      for (const g of greet) {
        await send(g.chat,
          `🏢 У «${nameOf(g.employerId)}» теперь есть профиль работодателя в vacante.\n\nДобавьте свои заведения: кандидаты увидят, где работать, а вакансии можно будет привязать к нужной точке. Открыть профиль: /company`);
      }
      const at = nowIso();
      for (const jobId of jobs) {
        const job = db.prepare("SELECT * FROM bot_jobs WHERE job_id = ? AND venue_id IS NULL AND asked_at IS NULL").get(jobId) as
          { tg_chat: number; employer_id: number | null } | undefined;
        if (!job?.employer_id || !isMember(job.tg_chat, job.employer_id)) continue;
        const venues = venuesOf(job.employer_id).filter((v) => v.review !== "pending");
        if (venues.length < 2) continue;
        const title = (db.prepare("SELECT title FROM employer_vacancies WHERE id = ?").get(`bot-${jobId}`) as { title: string } | undefined)?.title;
        db.prepare("UPDATE bot_jobs SET asked_at = ? WHERE job_id = ?").run(at, jobId);
        await send(job.tg_chat, `Вакансия №${jobId}${title ? ` «${title}»` : ""}: для какого заведения?`,
          venues.slice(0, VENUE_BUTTONS).map((v) => [{
            text: `${v.name}${v.city ? `, ${cityName(v.city, "ru")}` : ""}${v.address ? `, ${v.address}` : ""}`.slice(0, 60),
            callback_data: `c:jv:${jobId}:${v.id}`,
          }]));
      }
    },

    async venueReviewed(venueId, approved) {
      const venue = db.prepare("SELECT * FROM venues WHERE id = ?").get(venueId) as Record<string, unknown> | undefined;
      if (!venue) return;
      const name = venueView(venue).name;
      const members = db.prepare("SELECT tg_chat FROM members WHERE employer_id = ? AND confirmed_at IS NOT NULL").all(venue.employer_id as number) as { tg_chat: number }[];
      for (const m of members) {
        await send(m.tg_chat, approved
          ? `✅ Заведение «${name}» проверили и добавили в профиль: /company`
          : `Заведение «${name}» не прошло проверку. Если это ошибка, добавьте его ещё раз с точным адресом: /company`);
      }
    },

    async memberDecided(memberId, confirmed) {
      const m = db.prepare("SELECT tg_chat, employer_id FROM members WHERE id = ?").get(memberId) as { tg_chat: number; employer_id: number } | undefined;
      if (!m) return;
      if (confirmed) await send(m.tg_chat, `✅ Профиль «${nameOf(m.employer_id)}» подтверждён. Теперь можно добавлять заведения: /company`);
      else await send(m.tg_chat, `Не смогли подтвердить, что вы из «${nameOf(m.employer_id)}». Если это ошибка, откройте /company и найдите компанию ещё раз.`);
    },
  };
}

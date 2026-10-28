// CRM заведений для админки vacante.kz/admin/ (vacante/site/templates/admin.html): статусы и заметки
// хранятся здесь, в D1, чтобы были одинаковыми на всех устройствах. Доступ по ключу из пароля админки:
// sha256("crm:" + пароль), пароль лежит в секрете воркера ADMIN_PASSWORD (его кладёт bot.yml).
export const STATUSES = ["", "sent", "replied", "client", "no"];
const NOTE_LIMIT = 500;

export async function crmKey(password) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`crm:${password.normalize("NFKC")}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Админка открыта на vacante.kz, а воркер живёт на workers.dev: отвечаем только своему сайту
function cors(request, env) {
  const site = new URL(env.SITE_URL);
  const allowed = [site.origin, `${site.protocol}//www.${site.host}`];
  const origin = request.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : site.origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export async function crmApi(request, env, now = new Date()) {
  const headers = cors(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (!env.ADMIN_PASSWORD) return Response.json({ error: "нет пароля админки" }, { status: 503, headers });
  if (request.headers.get("Authorization") !== `Bearer ${await crmKey(env.ADMIN_PASSWORD)}`) {
    return Response.json({ error: "forbidden" }, { status: 403, headers });
  }
  if (request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT venue, status, note, contacted_at, updated_at FROM crm").all();
    const marks = Object.fromEntries(results.map(({ venue, ...m }) => [venue, m]));
    return Response.json({ marks }, { headers });
  }
  if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers });
  const body = await request.json().catch(() => null);
  const venue = body && typeof body.venue === "string" ? body.venue.trim() : "";
  if (!venue || venue.length > 200) return Response.json({ error: "нужен venue" }, { status: 400, headers });
  if ("status" in body && !STATUSES.includes(body.status)) return Response.json({ error: "неизвестный статус" }, { status: 400, headers });
  if ("note" in body && (typeof body.note !== "string" || body.note.length > NOTE_LIMIT)) {
    return Response.json({ error: `заметка до ${NOTE_LIMIT} символов` }, { status: 400, headers });
  }
  const old = (await env.DB.prepare("SELECT status, note, contacted_at FROM crm WHERE venue = ?").bind(venue).first()) || {
    status: "", note: "", contacted_at: null,
  };
  const at = now.toISOString();
  const status = "status" in body ? body.status : old.status;
  const note = "note" in body ? body.note : old.note;
  // Дата последнего контакта: каждый раз, когда ставят статус переписки (кроме «не писал»)
  const contacted = "status" in body && status ? at : old.contacted_at;
  await env.DB.prepare(
    "INSERT INTO crm (venue, status, note, contacted_at, updated_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT (venue) DO UPDATE SET status = excluded.status, note = excluded.note, " +
      "contacted_at = excluded.contacted_at, updated_at = excluded.updated_at",
  )
    .bind(venue, status, note, contacted, at)
    .run();
  return Response.json({ venue, status, note, contacted_at: contacted, updated_at: at }, { headers });
}

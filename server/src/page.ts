// Страница профиля для работодателя: p.vacante.kz/<код>. Открывается в любом браузере без входа.
// Превью ссылки в WhatsApp и Telegram видит только «Профиль кандидата в Vacante», без имени,
// поисковики страницу не индексируют, сторонних скриптов и Метрики на ней нет.
import type { Ctx } from "./app.ts";
import { html, raw, type Html } from "./html.ts";
import { HttpError, route, type Reply, type Request, type Route } from "./http.ts";
import {
  cityName,
  documentsLabel,
  employmentLabel,
  experienceLabel,
  languagesLabel,
  payLabel,
  phoneLabel,
  startLabel,
  type Lang,
} from "./labels.ts";
import type { Profile } from "./profile.ts";
import { CODE_RE, findLink, getProfile, profileUpdatedAt, recordView, type Link } from "./seekers.ts";

/** Программы, которые открывают ссылку ради превью или индекса, а не человек. */
const PREVIEW_BOT =
  /bot|crawl|spider|preview|whatsapp|facebookexternalhit|facebot|vkshare|viber|skypeuripreview|slack|discord|embedly|yandex|google-|bingpreview|curl|wget|python|httpx|okhttp|java\//i;

export const isPreviewBot = (ua: string | undefined) => !ua || PREVIEW_BOT.test(ua);

/** Ограничение частоты по адресу, только в памяти: чужую ссылку не подобрать перебором. */
export class RateLimit {
  private hits = new Map<string, { start: number; points: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit = 60, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  take(key: string, now: number, points = 1): boolean {
    const hit = this.hits.get(key);
    if (!hit || now - hit.start >= this.windowMs) {
      if (this.hits.size > 10_000) this.hits.clear();
      this.hits.set(key, { start: now, points });
      return points <= this.limit;
    }
    hit.points += points;
    return hit.points <= this.limit;
  }
}

const T = {
  ru: {
    title: "Профиль кандидата в Vacante",
    previewText: "Откройте ссылку, чтобы посмотреть профиль кандидата.",
    candidate: "Профиль кандидата",
    wants: "Хочет работать",
    experience: "Опыт",
    employment: "График",
    pay: "Зарплата",
    start: "Может выйти",
    languages: "Языки",
    documents: "Документы",
    about: "О себе",
    contact: "Связаться",
    showPhone: "Показать телефон",
    call: "Позвонить",
    noPhone: "Кандидат не оставил телефон. Ответьте ему в том чате, откуда пришла ссылка.",
    hello: (name: string) => `Здравствуйте, ${name}! Увидели ваш профиль в Vacante.`,
    gone: "Ссылка больше не работает",
    goneText: "Кандидат выключил эту ссылку или удалил профиль.",
    post: "Ищете сотрудников? Разместите вакансию бесплатно в боте Vacante",
    updated: "Профиль обновлён",
    other: "Қазақша",
  },
  kk: {
    title: "Vacante-дегі үміткер профилі",
    previewText: "Үміткердің профилін көру үшін сілтемені ашыңыз.",
    candidate: "Үміткер профилі",
    wants: "Қалайтын жұмысы",
    experience: "Тәжірибе",
    employment: "Кесте",
    pay: "Жалақы",
    start: "Жұмысқа шыға алады",
    languages: "Тілдер",
    documents: "Құжаттар",
    about: "Өзі туралы",
    contact: "Байланысу",
    showPhone: "Телефонды көрсету",
    call: "Қоңырау шалу",
    noPhone: "Үміткер телефон қалдырмаған. Сілтеме келген чатта жауап беріңіз.",
    hello: (name: string) => `Сәлеметсіз бе, ${name}! Vacante-де профиліңізді көрдік.`,
    gone: "Сілтеме енді жұмыс істемейді",
    goneText: "Үміткер бұл сілтемені өшірді немесе профилін жойды.",
    post: "Қызметкер іздейсіз бе? Vacante ботында бос орынды тегін орналастырыңыз",
    updated: "Профиль жаңартылды",
    other: "Русский",
  },
};

const STYLE = raw(`
:root{--bg:#f4f4f6;--card:#fff;--ink:#1d1d1f;--quiet:#6b6b70;--line:#e4e4e7;--accent:#0a8ff0;--pill:#e3f1fd}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f10;--card:#1d1d20;--ink:#f2f2f3;--quiet:#a1a1a8;--line:#2c2c30;--accent:#3aa5f5;--pill:#12304a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
main{max-width:520px;margin:0 auto;padding:16px}
header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.logo{font-weight:900;font-size:20px;letter-spacing:-.5px;color:var(--ink);text-decoration:none}
.lang{color:var(--quiet);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:20px}
.kicker{color:var(--quiet);font-size:13px;text-transform:uppercase;letter-spacing:.04em;margin:0 0 12px}
.who{display:flex;gap:16px;align-items:center;margin-bottom:16px}
.avatar{width:84px;height:84px;border-radius:50%;background:var(--pill);display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:800;color:var(--accent);flex:none;overflow:hidden}
.avatar video,.avatar img{width:100%;height:100%;object-fit:cover}
h1{font-size:26px;margin:0}.place{color:var(--quiet);margin:2px 0 0}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 12px}.chip{background:var(--pill);border-radius:12px;padding:4px 10px;font-weight:600}
dl{margin:0}dt{color:var(--quiet);font-size:13px;margin-top:10px}dd{margin:0;font-weight:600}
.about{white-space:pre-line;font-weight:400}
.contact{margin-top:20px;display:flex;flex-wrap:wrap;gap:8px}
.btn{flex:1 1 auto;display:block;text-align:center;background:var(--accent);color:#fff;text-decoration:none;font-weight:700;padding:14px 16px;border-radius:14px;border:0;font-size:16px}
.btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
.phone{font-size:22px;font-weight:800;width:100%;margin:4px 0}
.note{color:var(--quiet);font-size:14px}
footer{margin:20px 4px;color:var(--quiet);font-size:14px}footer a{color:var(--accent)}
`);

function page(lang: Lang, body: Html, other?: string): string {
  const t = T[lang];
  return html`<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>${t.title}</title>
<meta property="og:title" content="${t.title}">
<meta property="og:description" content="${t.previewText}">
<meta property="og:site_name" content="Vacante">
<style>${STYLE}</style>
</head>
<body><main>
<header><a class="logo" href="https://vacante.kz">vacante</a>${other ? html`<a class="lang" href="${other}">${t.other}</a>` : ""}</header>
${body}
</main></body>
</html>`.value;
}

function langOf(req: Request): Lang {
  const q = req.query.get("lang");
  if (q === "kk" || q === "ru") return q;
  return /^kk|,\s*kk/i.test(req.header("accept-language") ?? "") ? "kk" : "ru";
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

function profileBody(ctx: Ctx, link: Link, p: Profile, lang: Lang, showPhone: boolean, updatedAt: string): Html {
  const t = T[lang];
  const place = [cityName(p.city, lang), p.district].filter(Boolean).join(", ");
  const facts: [string, string | null][] = [
    [t.experience, experienceLabel(p, lang)],
    [t.employment, employmentLabel(p, lang)],
    [t.pay, payLabel(p, lang)],
    [t.start, startLabel(p, lang)],
    [t.languages, p.languages.length ? languagesLabel(p, lang) : null],
    [t.documents, documentsLabel(p, lang)],
  ];
  const phoneUrl = `/${link.code}?phone=1${lang === "kk" ? "&lang=kk" : ""}#contact`;
  const wa = p.phone ? `https://wa.me/${p.phone.slice(1)}?text=${encodeURIComponent(t.hello(p.name))}` : "";
  const contact = !p.phone
    ? html`<p class="note">${t.noPhone}</p>`
    : showPhone
      ? html`<p class="phone">${phoneLabel(p.phone)}</p>
<a class="btn" href="tel:${p.phone}">${t.call}</a><a class="btn ghost" href="${wa}">WhatsApp</a>`
      : html`<a class="btn" href="${phoneUrl}" rel="nofollow">${t.showPhone}</a>`;
  return html`<section class="card">
<p class="kicker">${t.candidate}</p>
<div class="who"><div class="avatar" aria-hidden="true">${initials(p.name)}</div>
<div><h1>${p.name}</h1><p class="place">${place}</p></div></div>
<dl>
<dt>${t.wants}</dt><dd><div class="chips">${p.roles.map((r) => html`<span class="chip">${r}</span>`)}</div></dd>
${facts.map(([label, value]) => (value ? html`<dt>${label}</dt><dd>${value}</dd>` : ""))}
${p.about ? html`<dt>${t.about}</dt><dd class="about">${p.about}</dd>` : ""}
</dl>
<div class="contact" id="contact">${contact}</div>
<p class="note">${t.updated}: ${updatedAt.slice(0, 10).split("-").reverse().join(".")}</p>
</section>
<footer><a href="https://t.me/${ctx.config.botUsername}?start=post">${t.post}</a></footer>`;
}

function gone(lang: Lang): Reply {
  const t = T[lang];
  return {
    status: 404,
    html: page(lang, html`<section class="card"><h1>${t.gone}</h1><p class="note">${t.goneText}</p></section>`),
  };
}

export function pageRoutes(ctx: Ctx): Route[] {
  const limit = new RateLimit();
  const clientOf = (req: Request) => (req.header("x-forwarded-for") ?? "").split(",")[0]?.trim() || "local";

  return [
    route("GET", "profile", "/", () => ({ status: 302, headers: { Location: ctx.config.siteUrl } })),
    route("GET", "profile", "/robots.txt", () => ({
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: Buffer.from("User-agent: *\nDisallow: /\n"),
    })),

    route("GET", "profile", "/:code", (req) => {
      const lang = langOf(req);
      const client = clientOf(req);
      const now = ctx.now();
      if (!limit.take(client, now)) throw new HttpError(429, "Слишком много запросов, попробуйте через минуту");
      const code = req.params.code ?? "";
      const link = CODE_RE.test(code) ? findLink(ctx.db, code, now) : undefined;
      const profile = link && getProfile(ctx.db, link.seeker_id);
      if (!link || !profile) {
        // Неудачная попытка стоит дороже: так перебор кодов упрётся в ограничение за секунды
        limit.take(client, now, 4);
        return gone(lang);
      }
      const t = T[lang];
      // Превью ссылки и проверки HEAD не считаются просмотром и не видят данных
      if (req.method === "HEAD" || isPreviewBot(req.header("user-agent"))) {
        return { html: page(lang, html`<section class="card"><h1>${t.title}</h1><p class="note">${t.previewText}</p></section>`) };
      }
      const showPhone = req.query.get("phone") === "1" && !!profile.phone;
      const cookies = req.header("cookie") ?? "";
      const viewed = cookies.includes(`v_${code}=1`);
      const phoned = cookies.includes(`p_${code}=1`);
      const setCookies: string[] = [];
      if (!viewed || (showPhone && !phoned)) {
        recordView(ctx.db, {
          seeker_id: link.seeker_id,
          link_code: code,
          application_id: link.application_id,
          viewer: null,
          phone: showPhone,
          now,
        });
      }
      // Одно открытие в полдня с одного телефона, чтобы обновление страницы не считалось новым просмотром
      const cookie = (name: string) => `${name}_${code}=1; Max-Age=43200; Path=/${code}; Secure; HttpOnly; SameSite=Lax`;
      if (!viewed) setCookies.push(cookie("v"));
      if (showPhone && !phoned) setCookies.push(cookie("p"));
      const updatedAt = profileUpdatedAt(ctx.db, link.seeker_id) ?? "";
      const other = `/${code}?lang=${lang === "kk" ? "ru" : "kk"}`;
      return {
        html: page(lang, profileBody(ctx, link, profile, lang, showPhone, updatedAt), other),
        headers: {
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
          ...(setCookies.length ? { "Set-Cookie": setCookies } : {}),
        },
      };
    }),
  ];
}

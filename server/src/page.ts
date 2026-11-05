// Страница профиля для работодателя: p.vacante.kz/<код>. Открывается в любом браузере без входа.
// Превью ссылки в WhatsApp и Telegram без имени и данных анкеты: «Профиль кандидата в Vacante»,
// а если соискатель сам включил галочку, ещё фото (или кадр кружка) и «▶ Видео 0:42», и Telegram
// может проиграть сам кружок прямо в превью.
// Поисковики страницу не индексируют, сторонних скриптов и Метрики на ней нет.
import type { Ctx } from "./app.ts";
import {
  answerable,
  employerAnswer,
  getApplication,
  lastEmployerAnswer,
  markSeen,
  type Answer,
  type ApplicationRow,
} from "./applications.ts";
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
import { RateLimit } from "./limits.ts";
import { sendNews } from "./notify.ts";
import {
  CODE_RE,
  findLink,
  getPhoto,
  getProfile,
  getSeeker,
  getVideo,
  iso,
  profileUpdatedAt,
  recordView,
  type Link,
  type Video,
} from "./seekers.ts";
import { dateTimeLabel, DAY_MS, fromLocal, toLocalInput } from "./time.ts";
import { duration, fileReply } from "./video.ts";
import { join } from "node:path";

/** Программы, которые открывают ссылку ради превью или индекса, а не человек. */
const PREVIEW_BOT =
  /bot|crawl|spider|preview|whatsapp|facebookexternalhit|facebot|vkshare|viber|skypeuripreview|slack|discord|embedly|yandex|google-|bingpreview|curl|wget|python|httpx|okhttp|java\//i;

export const isPreviewBot = (ua: string | undefined) => !ua || PREVIEW_BOT.test(ua);

const T = {
  ru: {
    title: "Профиль кандидата в Vacante",
    previewText: "Откройте ссылку, чтобы посмотреть профиль кандидата.",
    previewVideo: (length: string) => `▶ Видео ${length} · Профиль кандидата`,
    previewVideoText: "Откройте ссылку, чтобы посмотреть кружок и профиль кандидата.",
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
    watch: "▶ Смотреть кружок",
    forVacancy: (title: string) => `Отклик на вакансию «${title}»`,
    answerTitle: "Ответить кандидату",
    answerAgain: "Изменить ответ",
    when: "Дата и время собеседования, если уже знаете",
    invite: "Пригласить на собеседование",
    reject: "Не подходит",
    answerNote: "Кандидат сразу получит ваш ответ в Telegram.",
    invited: (when: string) => `✅ Вы пригласили кандидата на собеседование${when ? `: ${when}` : ""}.`,
    rejected: "Вы ответили «Не подходит».",
    badDate: "Проверьте дату: она уже прошла или слишком далеко.",
  },
  kk: {
    title: "Vacante-дегі үміткер профилі",
    previewText: "Үміткердің профилін көру үшін сілтемені ашыңыз.",
    previewVideo: (length: string) => `▶ Бейнехабар ${length} · Үміткер профилі`,
    previewVideoText: "Үміткердің бейнехабары мен профилін көру үшін сілтемені ашыңыз.",
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
    watch: "▶ Бейнехабарды көру",
    forVacancy: (title: string) => `«${title}» бос орнына өтінім`,
    answerTitle: "Үміткерге жауап беру",
    answerAgain: "Жауапты өзгерту",
    when: "Сұхбаттың күні мен уақыты, егер белгілі болса",
    invite: "Сұхбатқа шақыру",
    reject: "Сәйкес келмейді",
    answerNote: "Үміткер жауабыңызды бірден Telegram-да алады.",
    invited: (when: string) => `✅ Сіз үміткерді сұхбатқа шақырдыңыз${when ? `: ${when}` : ""}.`,
    rejected: "Сіз «Сәйкес келмейді» деп жауап бердіңіз.",
    badDate: "Күнін тексеріңіз: ол өтіп кеткен немесе тым алыс.",
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
.avatar{width:84px;height:84px;border-radius:50%;background:var(--pill);display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:800;color:var(--accent);flex:none;overflow:hidden;text-decoration:none}
.avatar img{width:100%;height:100%;object-fit:cover;object-position:50% 30%;display:block}
.circle{display:block;position:relative;width:220px;height:220px;margin:0 auto 18px;border-radius:50%;overflow:hidden;background:#101012;text-decoration:none}
.circle img{width:100%;height:100%;object-fit:cover;display:block}
.play{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);background:rgba(0,0,0,.62);color:#fff;font-weight:700;font-size:15px;border-radius:999px;padding:6px 14px;white-space:nowrap}
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
.answer{margin-top:20px;padding-top:16px;border-top:1px solid var(--line)}
.field{display:block;margin:0 0 4px}.field span{display:block;color:var(--quiet);font-size:13px;margin-bottom:6px}
.field input{width:100%;font:inherit;padding:12px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
button.btn{cursor:pointer;font-family:inherit}
.done{background:var(--pill);border-radius:14px;padding:12px 14px;font-weight:600;margin:16px 0 0}
.error{color:#d33;font-weight:600}
`);

/** Что показать в превью ссылки сверх «Профиль кандидата в Vacante». */
interface Preview {
  title?: string;
  text?: string;
  image?: { url: string; width?: number; height?: number };
  /** Адрес кружка: Telegram проигрывает его прямо в превью, WhatsApp показывает только картинку. */
  video?: string;
}

/** WhatsApp не показывает в превью картинку тяжелее ~300 КБ. */
export const PREVIEW_MAX_BYTES = 300_000;
/** Кружок квадратный: из размера Telegram берёт пропорции и величину плеера в превью. */
const CIRCLE_SIDE = 640;

/**
 * Картинка и кружок для превью. Картинка крупная, чтобы Telegram поставил её во всю ширину, а не
 * значком сбоку. Кружок описан теми же метками, по которым Telegram проигрывает видео других сайтов.
 */
function mediaMeta({ image, video }: Preview): Html | "" {
  if (!image && !video) return "";
  return html`${
    image
      ? html`<meta property="og:image" content="${image.url}">
<meta property="og:image:type" content="image/jpeg">
${image.width && image.height ? html`<meta property="og:image:width" content="${image.width}">
<meta property="og:image:height" content="${image.height}">
` : ""}`
      : ""
  }${
    video
      ? html`<meta property="og:video" content="${video}">
<meta property="og:video:secure_url" content="${video}">
<meta property="og:video:type" content="video/mp4">
<meta property="og:video:width" content="${CIRCLE_SIDE}">
<meta property="og:video:height" content="${CIRCLE_SIDE}">
<meta property="twitter:player:stream" content="${video}">
<meta property="twitter:player:stream:content_type" content="video/mp4">
<meta property="twitter:player:width" content="${CIRCLE_SIDE}">
<meta property="twitter:player:height" content="${CIRCLE_SIDE}">
`
      : ""
  }<meta property="twitter:card" content="${video ? "player" : "summary_large_image"}">
`;
}

function page(lang: Lang, body: Html, other?: string, preview: Preview = {}): string {
  const t = T[lang];
  return html`<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>${t.title}</title>
<meta property="og:title" content="${preview.title ?? t.title}">
<meta property="og:description" content="${preview.text ?? t.previewText}">
<meta property="og:site_name" content="Vacante">
${mediaMeta(preview)}<style>${STYLE}</style>
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

function profileBody(
  ctx: Ctx,
  link: Link,
  p: Profile,
  video: Video | undefined,
  photo: boolean,
  lang: Lang,
  showPhone: boolean,
  updatedAt: string,
  application?: { title: string; answer: Html },
): Html {
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
<p class="kicker">${application ? t.forVacancy(application.title) : t.candidate}</p>
${video?.file ? circle(link.code, video, t.watch) : ""}
<div class="who">${
    photo
      ? html`<a class="avatar" href="/${link.code}/photo.jpg"><img src="/${link.code}/photo.jpg" alt="${p.name}"></a>`
      : html`<div class="avatar" aria-hidden="true">${initials(p.name)}</div>`
  }
<div><h1>${p.name}</h1><p class="place">${place}</p></div></div>
<dl>
<dt>${t.wants}</dt><dd><div class="chips">${p.roles.map((r) => html`<span class="chip">${r}</span>`)}</div></dd>
${facts.map(([label, value]) => (value ? html`<dt>${label}</dt><dd>${value}</dd>` : ""))}
${p.about ? html`<dt>${t.about}</dt><dd class="about">${p.about}</dd>` : ""}
</dl>
<div class="contact" id="contact">${contact}</div>
${application?.answer ?? ""}
<p class="note">${t.updated}: ${updatedAt.slice(0, 10).split("-").reverse().join(".")}</p>
</section>
<footer><a href="https://t.me/${ctx.config.botUsername}?start=post">${t.post}</a></footer>`;
}

/**
 * Кружок без скриптов: обложка в круге, нажатие открывает видео встроенным плеером браузера.
 * Так он работает и во встроенных браузерах WhatsApp и Telegram.
 */
function circle(code: string, video: Video, watch: string): Html {
  return html`<a class="circle" href="/${code}/video.mp4">${video.poster ? html`<img src="/${code}/poster.jpg" alt="">` : ""}<span class="play">${watch} · ${duration(video.duration)}</span></a>`;
}

/**
 * Ответ работодателя без скриптов: обычная форма с полем даты и двумя кнопками.
 * Время в поле — время Казахстана, как на телефоне работодателя.
 */
function answerBlock(code: string, app: ApplicationRow, last: { stage: string } | undefined, lang: Lang, now: number, error: boolean): Html {
  const t = T[lang];
  const done =
    last?.stage === "rejected"
      ? html`<p class="done">${t.rejected}</p>`
      : last && (last.stage === "invited" || last.stage === "interview")
        ? html`<p class="done">${t.invited(app.interview_at ? dateTimeLabel(Date.parse(app.interview_at), lang) : "")}</p>`
        : "";
  if (!answerable(app.stage)) return html`${done}`;
  const action = `/${code}/answer${lang === "kk" ? "?lang=kk" : ""}`;
  const value = app.interview_at && Date.parse(app.interview_at) > now ? toLocalInput(Date.parse(app.interview_at)) : "";
  return html`${done}<form class="answer" id="answer" method="post" action="${action}">
<p class="kicker">${done ? t.answerAgain : t.answerTitle}</p>
${error ? html`<p class="error">${t.badDate}</p>` : ""}
<label class="field"><span>${t.when}</span><input type="datetime-local" name="at" value="${value}" min="${toLocalInput(now)}" max="${toLocalInput(now + 90 * DAY_MS)}"></label>
<div class="contact"><button class="btn" name="answer" value="invite">${t.invite}</button><button class="btn ghost" name="answer" value="reject">${t.reject}</button></div>
<p class="note">${t.answerNote}</p>
</form>`;
}

/**
 * Превью ссылки, когда соискатель сам включил «Показывать фото и кружок в превью ссылки»: фото или
 * кадр кружка, длина кружка и сам кружок для Telegram. Имени и данных анкеты в превью нет и с галочкой.
 */
function previewOf(ctx: Ctx, link: Link, video: Video | undefined, lang: Lang): Preview {
  if (!getSeeker(ctx.db, link.seeker_id)?.preview_at) return {};
  const t = T[lang];
  const base = `${ctx.config.profileOrigin}/${link.code}`;
  // Новое фото или кружок — новый адрес картинки, иначе мессенджер покажет прежнюю из своего кэша
  const version = (at: string) => Math.floor(Date.parse(at) / 1000).toString(36);
  const photo = getPhoto(ctx.db, link.seeker_id);
  const frame = video?.file && video.poster ? `${base}/poster.jpg?v=${version(video.recorded_at)}` : null;
  // Тяжёлое фото из прежнего приложения WhatsApp не покажет: тогда лучше кадр кружка
  const image =
    photo && (photo.size <= PREVIEW_MAX_BYTES || !frame)
      ? { url: `${base}/photo.jpg?v=${version(photo.uploaded_at)}`, width: photo.width, height: photo.height }
      : frame
        ? { url: frame }
        : undefined;
  return video?.file
    ? {
        title: t.previewVideo(duration(video.duration)),
        text: t.previewVideoText,
        image,
        video: `${base}/video.mp4?v=${version(video.recorded_at)}`,
      }
    : { image };
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

  const media = (req: Request, kind: "file" | "poster" | "photo", type: string): Reply => {
    const now = ctx.now();
    const client = clientOf(req);
    if (!limit.take(client, now)) throw new HttpError(429, "Слишком много запросов, попробуйте через минуту");
    const code = req.params.code ?? "";
    const link = CODE_RE.test(code) ? findLink(ctx.db, code, now) : undefined;
    const name = !link
      ? undefined
      : kind === "photo"
        ? getPhoto(ctx.db, link.seeker_id)?.file
        : getVideo(ctx.db, link.seeker_id)?.[kind];
    if (!name) {
      limit.take(client, now, 4);
      throw new HttpError(404, "Нет файла");
    }
    return fileReply(req, join(ctx.config.videosDir, name), type);
  };

  return [
    route("GET", "profile", "/", () => ({ status: 302, headers: { Location: ctx.config.siteUrl } })),
    route("GET", "profile", "/robots.txt", () => ({
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: Buffer.from("User-agent: *\nDisallow: /\n"),
    })),

    // Кружок, обложка и фото по той же ссылке: выключили ссылку или удалили файл — его больше нет.
    // Просмотром не считаются, это делает сама страница
    route("GET", "profile", "/:code/video.mp4", (req) => media(req, "file", "video/mp4")),
    route("GET", "profile", "/:code/poster.jpg", (req) => media(req, "poster", "image/jpeg")),
    route("GET", "profile", "/:code/photo.jpg", (req) => media(req, "photo", "image/jpeg")),

    // Ответ работодателя кнопкой: кандидат сразу получает сообщение, стадия отклика меняется сама
    route("POST", "profile", "/:code/answer", async (req) => {
      const lang = langOf(req);
      const client = clientOf(req);
      const now = ctx.now();
      if (!limit.take(client, now)) throw new HttpError(429, "Слишком много запросов, попробуйте через минуту");
      const code = req.params.code ?? "";
      const link = CODE_RE.test(code) ? findLink(ctx.db, code, now) : undefined;
      if (!link?.application_id) {
        limit.take(client, now, 4);
        return gone(lang);
      }
      const back = (extra: Record<string, string> = {}): Reply => {
        const query = new URLSearchParams({ ...(lang === "kk" ? { lang } : {}), ...extra }).toString();
        return { status: 303, headers: { Location: `/${code}${query ? `?${query}` : ""}#answer` } };
      };
      const form = await req.form();
      const kind = form.get("answer");
      if (kind !== "invite" && kind !== "reject") return back();
      let at: string | null = null;
      const raw = (form.get("at") ?? "").trim();
      if (kind === "invite" && raw) {
        const ms = fromLocal(raw);
        // Собеседование не в прошлом (час на то, что форму заполняли не спеша) и не дальше трёх месяцев
        if (ms === null || ms < now - 3_600_000 || ms > now + 90 * DAY_MS) return back({ error: "date" });
        at = iso(ms);
      }
      const answer: Answer = kind === "invite" ? { kind: "invite", at } : { kind: "reject" };
      const changed = employerAnswer(ctx.db, link.seeker_id, link.application_id, answer, now);
      if (changed) ctx.background(sendNews(ctx, kind, changed));
      return back();
    }),

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
      const video = getVideo(ctx.db, link.seeker_id);
      const preview = previewOf(ctx, link, video, lang);
      // Превью ссылки и проверки HEAD не считаются просмотром и не видят данных анкеты
      if (req.method === "HEAD" || isPreviewBot(req.header("user-agent"))) {
        return {
          html: page(lang, html`<section class="card"><h1>${t.title}</h1><p class="note">${t.previewText}</p></section>`, undefined, preview),
        };
      }
      const showPhone = req.query.get("phone") === "1" && !!profile.phone;
      // Ссылка отклика: работодатель открыл профиль — отклик «Просмотрен», а кандидату пишет бот
      const app = link.application_id ? getApplication(ctx.db, link.seeker_id, link.application_id) : undefined;
      if (app && markSeen(ctx.db, app.id, now)) ctx.background(sendNews(ctx, "seen", app));
      const cookies = req.header("cookie") ?? "";
      const viewed = cookies.includes(`v_${code}=1`);
      const phoned = cookies.includes(`p_${code}=1`);
      const setCookies: string[] = [];
      if (!viewed || (showPhone && !phoned)) {
        recordView(ctx.db, {
          seeker_id: link.seeker_id,
          link_code: code,
          application_id: link.application_id,
          viewer: app?.employer ?? null,
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
      const fresh = app && getApplication(ctx.db, link.seeker_id, app.id);
      const application = fresh
        ? {
            title: (lang === "kk" && fresh.title_kk) || fresh.title,
            answer: answerBlock(code, fresh, lastEmployerAnswer(ctx.db, fresh.id), lang, now, req.query.get("error") === "date"),
          }
        : undefined;
      const photo = !!getPhoto(ctx.db, link.seeker_id);
      return {
        html: page(lang, profileBody(ctx, link, profile, video, photo, lang, showPhone, updatedAt, application), other, preview),
        headers: {
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
          ...(setCookies.length ? { "Set-Cookie": setCookies } : {}),
        },
      };
    }),
  ];
}

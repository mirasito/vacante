import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { distanceKm, find2gisLink, pointFrom2gisUrl, previewFromHtml, resolve2gis, roundHome } from "../src/geo.ts";
import { BROWSER, count, initDataFor, startServer, type TestServer } from "./helpers.ts";

const point = (href: string) => pointFrom2gisUrl(new URL(href));

// Страница дома в 2ГИС так, как её видит превью ссылок: картинка с точкой и подписью
const PREVIEW =
  "https://share.api.2gis.ru/getimage?city=almaty&amp;zoom=17&amp;center=76.912345%2C43.238912" +
  "&amp;title=%D0%96%D0%B8%D0%BB%D0%BE%D0%B9%20%D0%B4%D0%BE%D0%BC&amp;desc=%D0%90%D0%B1%D0%B0%D1%8F%20%D0%BF%D1%80%D0%BE%D1%81%D0%BF%D0%B5%D0%BA%D1%82%2C%20150%3Cbr%20%2F%3E%D0%90%D0%BB%D0%BC%D0%B0%D1%82%D1%8B";
const HOUSE_PAGE = `<!doctype html><html lang="ru"><head>
<meta property="og:title" content="Жилой дом, Абая проспект, 150">
<meta property="twitter:image" content="${PREVIEW}" />
</head><body></body></html>`;

/** 2ГИС для тестов: короткая ссылка ведёт на страницу дома, страница отдаёт превью. */
function fake2gis(calls: string[], routes: Record<string, () => Response>) {
  return (async (input: string | URL | Request) => {
    const href = String(input instanceof Request ? input.url : input);
    calls.push(href);
    const reply = routes[href];
    return reply ? reply() : new Response("Not Found", { status: 404 });
  }) as typeof fetch;
}

const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });
const html = (body: string) => () => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

test("ссылка 2ГИС в тексте, которым делится приложение 2ГИС", () => {
  assert.equal(find2gisLink("Абая проспект, 150, Алматы\nhttps://go.2gis.com/x7k2p")?.href, "https://go.2gis.com/x7k2p");
  assert.equal(find2gisLink("http://2gis.kz/almaty/geo/123")?.href, "https://2gis.kz/almaty/geo/123");
  assert.equal(find2gisLink("https://2gis.kz.evil.example/almaty"), null);
  assert.equal(find2gisLink("https://evil.example/2gis.kz"), null);
  assert.equal(find2gisLink("https://user@2gis.kz/almaty"), null);
  assert.equal(find2gisLink("мкр Аксай-4, 25"), null);
});

test("точка прямо из ссылки: в пути, в центре карты и в картинке превью", () => {
  assert.deepEqual(point("https://2gis.kz/almaty/geo/76.912345%2C43.238912"), { lat: 43.238912, lon: 76.912345 });
  assert.deepEqual(point("https://2gis.kz/almaty/firm/70000001043503020/76.945654,43.238293?m=76.94%2C43.23%2F16"), {
    lat: 43.238293,
    lon: 76.945654,
  });
  assert.deepEqual(point("https://2gis.kz/astana?m=71.4304%2C51.1282%2F17.5"), { lat: 51.1282, lon: 71.4304 });
  assert.deepEqual(point("https://share.api.2gis.ru/getimage?zoom=17&center=69.6%2C42.31"), { lat: 42.31, lon: 69.6 });
  assert.equal(point("https://2gis.kz/almaty/geo/9430047374978476"), null);
  // Дубай и перепутанные широта с долготой: не Казахстан
  assert.equal(point("https://2gis.ae/dubai/geo/55.171971%2C25.289452"), null);
  assert.equal(point("https://2gis.kz/almaty/geo/43.238912%2C76.912345"), null);
});

test("картинка превью со страницы 2ГИС", () => {
  const preview = previewFromHtml(HOUSE_PAGE);
  assert.ok(preview);
  assert.deepEqual(pointFrom2gisUrl(preview), { lat: 43.238912, lon: 76.912345 });
  assert.equal(previewFromHtml('<meta property="twitter:image" content="https://evil.example/getimage?center=76.9%2C43.2">'), null);
  assert.equal(previewFromHtml("<html></html>"), null);
});

test("короткая ссылка: переход на страницу дома, точка из превью, подпись для проверки", async () => {
  const calls: string[] = [];
  const fetchFn = fake2gis(calls, {
    "https://go.2gis.com/x7k2p": redirect("https://2gis.kz/almaty/geo/9430047374978476"),
    "https://2gis.kz/almaty/geo/9430047374978476": html(HOUSE_PAGE),
  });
  const found = await resolve2gis(fetchFn, "Абая проспект, 150, Алматы https://go.2gis.com/x7k2p");
  assert.deepEqual(found, { lat: 43.238912, lon: 76.912345, label: "Жилой дом, Абая проспект, 150, Алматы" });
  assert.deepEqual(calls, ["https://go.2gis.com/x7k2p", "https://2gis.kz/almaty/geo/9430047374978476"]);

  // Точка уже в адресе перехода: страницу не открываем
  const fewer: string[] = [];
  const withPoint = fake2gis(fewer, {
    "https://go.2gis.com/abc12": redirect("https://2gis.kz/almaty/geo/9430047374978476?m=76.9286%2C43.234%2F17"),
  });
  assert.deepEqual(await resolve2gis(withPoint, "https://go.2gis.com/abc12"), { lat: 43.234, lon: 76.9286, label: null });
  assert.equal(fewer.length, 1);

  // Переход на чужой сайт не открываем
  const foreign: string[] = [];
  const away = fake2gis(foreign, { "https://go.2gis.com/bad": redirect("https://evil.example/geo/76.9%2C43.2") });
  assert.equal(await resolve2gis(away, "https://go.2gis.com/bad"), null);
  assert.deepEqual(foreign, ["https://go.2gis.com/bad"]);

  // Страница без превью
  const empty = fake2gis([], { "https://2gis.kz/almaty/geo/1": html("<html></html>") });
  assert.equal(await resolve2gis(empty, "https://2gis.kz/almaty/geo/1"), null);
});

test("округление дома и расстояние", () => {
  assert.equal(roundHome(43.23891), 43.24);
  assert.equal(roundHome(76.91234), 76.91);
  assert.equal(roundHome(51.1274), 51.125);
  const km = distanceKm({ lat: 43.238, lon: 76.945 }, { lat: 51.128, lon: 71.43 });
  assert.ok(km > 950 && km < 990, String(km)); // Алматы — Астана
});

const ANKETA = {
  name: "Асель",
  city: "almaty",
  roles: ["Повар"],
  experience: "gt3",
  employment: ["shifts"],
  start: "week",
};
const CONSENT = { version: "2026-11-04.2", adult: true, base: false };
const ASEL = { id: 7401, first_name: "Асель", language_code: "ru" };
const auth = (user: Record<string, unknown> = ASEL) => ({ authorization: `tma ${initDataFor(user)}` });

let s: TestServer;
const calls: string[] = [];
before(async () => {
  s = await startServer({
    fetch: fake2gis(calls, {
      "https://go.2gis.com/x7k2p": redirect("https://2gis.kz/almaty/geo/9430047374978476"),
      "https://2gis.kz/almaty/geo/9430047374978476": html(HOUSE_PAGE),
    }),
  });
});
after(() => s.close());

test("дом по ссылке 2ГИС: ответ без записи в базу, ещё до профиля", async () => {
  const r = await s.call("POST", "/me/home/link", { headers: auth(), body: { link: "Мой дом https://go.2gis.com/x7k2p" } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { lat: 43.24, lon: 76.91, source: "2gis", label: "Жилой дом, Абая проспект, 150, Алматы" });
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM seekers"), 0);

  const notLink = await s.call("POST", "/me/home/link", { headers: auth(), body: { link: "мкр Аксай-4, 25" } });
  assert.equal(notLink.status, 400);
  const unknown = await s.call("POST", "/me/home/link", { headers: auth(), body: { link: "https://go.2gis.com/zzz" } });
  assert.equal(unknown.status, 422);
  assert.equal((await s.call("POST", "/me/home/link", { body: { link: "https://go.2gis.com/x7k2p" } })).status, 401);
});

test("дом в профиле: округлён, виден только самому соискателю, правка старым приложением его не стирает", async () => {
  const created = await s.call("PUT", "/me/profile", {
    headers: { ...auth(), "x-vacante-beta": "1" },
    body: { consent: CONSENT, profile: { ...ANKETA, home: { lat: 43.238912, lon: 76.912345, source: "phone" } }, lang: "ru" },
  });
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(created.json.profile.home, { lat: 43.24, lon: 76.91, source: "phone" });
  const row = s.db.prepare("SELECT home_lat, home_lon, home_source FROM profiles WHERE seeker_id = ?").get(ASEL.id);
  assert.deepEqual({ ...row }, { home_lat: 43.24, home_lon: 76.91, home_source: "phone" });

  // Работодатель точку не видит
  const { code } = (await s.call("POST", "/me/link", { headers: auth() })).json;
  const page = await s.call("GET", `/${code}`, { host: "p.vacante.kz", headers: { "user-agent": BROWSER } });
  assert.equal(page.status, 200);
  assert.match(page.text, /Асель/);
  assert.doesNotMatch(page.text, /43\.2|76\.9|home/);

  // Лента приложения узнаёт дом из /me, чтобы показать, далеко ли работа
  const me = await s.call("GET", "/me", { headers: auth() });
  assert.deepEqual(me.json.home, { lat: 43.24, lon: 76.91 });
  const stranger = await s.call("GET", "/me", { headers: auth({ id: 7402, first_name: "Ерлан" }) });
  assert.equal(stranger.json.home, null);

  // Приложение до этой версии про дом не знает: точка остаётся
  const old = await s.call("PUT", "/me/profile", { headers: auth(), body: { profile: { ...ANKETA, about: "Люблю готовить" } } });
  assert.equal(old.status, 200);
  assert.deepEqual(old.json.profile.home, { lat: 43.24, lon: 76.91, source: "phone" });

  // Убрать дом
  const cleared = await s.call("PUT", "/me/profile", { headers: auth(), body: { profile: { ...ANKETA, home: null } } });
  assert.equal(cleared.json.profile.home, null);
  assert.equal((await s.call("GET", "/me", { headers: auth() })).json.home, null);

  // Точка не в Казахстане и мусор вместо точки
  for (const home of [{ lat: 25.28, lon: 55.17, source: "phone" }, { lat: "43", lon: 76, source: "phone" }, { lat: 43.2, lon: 76.9, source: "gps" }]) {
    const bad = await s.call("PUT", "/me/profile", { headers: auth(), body: { profile: { ...ANKETA, home } } });
    assert.equal(bad.status, 400, JSON.stringify(home));
  }
});

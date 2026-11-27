"""Счётчики сайта без имён: vacante/site/static/via.js и фильтры списка, которые не должны стирать метки из адреса.

Код страницы запускается в Node на подставной странице: адрес, сайт, с которого пришли, хранилище вкладки,
sendBeacon, fetch и Метрика подменены и записывают, что с ними сделал скрипт.
"""

import json
import shutil
import subprocess
from datetime import datetime, timezone

import pytest

from vacante.models import RawPost
from vacante.parse import parse_post
from vacante.site import build as site
from vacante.store import save_vacancies

API = "https://api.vacante.kz"
GO = API + "/go/chan-31/wa?s=web&t=%D0%9F%D0%BE%D0%B2%D0%B0%D1%80+2"  # прямая кнопка «Написать в WhatsApp»
POST = "https://vacante.kz/app/?tab=post&from=site_header"  # кнопка «Разместить вакансию» в шапке
HH = {"href": "https://hh.kz/vacancy/5", "data": {"kind": "hh", "id": "hh-5"}}
APP = {"href": "https://t.me/vacantekz_bot?startapp=sweb_a_almaty_hh-5", "data": {"kind": "app", "id": "hh-5"}}

# Открывает страницы из stdin (каждая — новая вкладка), нажимает на них ссылки и печатает, что сделал скрипт
PAGES = r"""
const fs = require('fs');
const vm = require('vm');
const code = fs.readFileSync(process.argv[1], 'utf8');
const done = JSON.parse(fs.readFileSync(0, 'utf8')).map((page) => {
  const seen = { beacons: [], fetches: [], ym: [], hrefs: [], errors: [] };
  const listeners = {};
  const stored = new Map(page.stored === undefined ? [] : [['via', page.stored]]);
  const dataset = { api: page.api === undefined ? 'https://api.vacante.kz' : page.api,
    metrika: page.metrika === undefined ? '77' : page.metrika };
  const window = {
    URL, URLSearchParams,
    location: new URL(page.url),
    document: { referrer: page.referrer || '', currentScript: { dataset },
      addEventListener: (type, fn) => { listeners[type] = fn; } },
    navigator: {},
    fetch: (url, init) => { seen.fetches.push([url, init]); return Promise.resolve(); },
  };
  window.window = window;
  if (page.storage === false) {
    Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('хранилище закрыто'); } });
  } else {
    window.sessionStorage = { getItem: (key) => (stored.has(key) ? stored.get(key) : null),
      setItem: (key, value) => stored.set(key, String(value)) };
  }
  if (page.beacon !== 'none') {
    window.navigator.sendBeacon = (url, body) => { seen.beacons.push([url, body]); return page.beacon !== 'refused'; };
  }
  if (page.ym !== 'none') {
    window.ym = (...args) => { if (page.ym === 'broken') throw new Error('Метрика сломана'); seen.ym.push(args); };
  }
  vm.runInNewContext(code, window);
  for (const click of page.clicks || []) {
    const el = click.href === undefined ? null : { href: click.href, dataset: click.data || {} };
    try {
      listeners[click.type || 'click']({ button: click.button || 0, target: { closest: () => el } });
    } catch (e) { seen.errors.push(String(e)); }
    seen.hrefs.push(el && el.href);
  }
  return Object.assign(seen, { via: window.vacanteVia, stored: stored.get('via') });
});
console.log(JSON.stringify(done));
"""

# Вызывает save() из страницы списка с заданным адресом и значениями фильтров, печатает адреса после неё
SAVE = r"""
const fs = require('fs');
const { save, pages } = JSON.parse(fs.readFileSync(0, 'utf8'));
const field = (value) => (value === undefined ? null : { value });
const done = pages.map((page) => {
  let address = null;
  const run = new Function('location', 'history', 'q', 'sort', 'fresh', 'cat', 'pay', 'state', save + '\nsave();');
  run(new URL(page.url), { replaceState: (state, title, url) => { address = url; } }, { value: page.q || '' },
    field(page.sort), field(page.fresh), field(page.cat), field(page.pay), () => ({ need: page.perks || [] }));
  return address;
});
console.log(JSON.stringify(done));
"""


def node(script: str, data, *args: str):
    node_path = shutil.which("node")
    if not node_path:
        pytest.skip("нет node")
    done = subprocess.run([node_path, "-e", script, *args], input=json.dumps(data), capture_output=True, text=True,
                          encoding="utf-8", timeout=60)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


def open_pages(*pages: dict) -> list[dict]:
    return node(PAGES, pages, str(site.HERE / "static" / "via.js"))


def test_source_label_comes_from_utm_then_referrer():
    cases = [
        # Метка utm_source в адресе страницы главнее сайта, с которого перешли
        ("?utm_source=chatgpt.com", "https://www.google.com/", "chatgpt"),
        ("?utm_source=ChatGPT", "", "chatgpt"), ("?utm_source=openai", "", "chatgpt"),
        ("?utm_source=telegram&utm_medium=channel&utm_campaign=post", "", "tg"), ("?utm_source=tg", "", "tg"),
        ("?utm_source=instagram", "", "ig"), ("?utm_source=ig", "", "ig"),
        ("?utm_source=perplexity", "", "perplex"), ("?utm_source=perplexity.ai", "", "perplex"),
        # Незнакомая метка: строчные латинские буквы и цифры, первые восемь; ничего не осталось — «other»
        ("?utm_source=Google-Ads_2026", "", "googlead"), ("?utm_source=%D1%82%D0%B5%D1%81%D1%82", "", "other"),
        ("?utm_source=__proto__", "", "proto"), ("?utm_source=", "https://www.google.com/", "google"),
        # Сайт, с которого перешли
        ("", "https://gemini.google.com/app", "gemini"), ("", "https://www.google.com/", "google"),
        ("", "https://www.google.com.kz/search?q=x", "google"), ("", "https://google.kz/", "google"),
        ("", "https://www.bing.com/search?q=x", "bing"), ("", "https://yandex.kz/search/", "yandex"),
        ("", "https://ya.ru/", "yandex"), ("", "https://duckduckgo.com/", "ddg"),
        ("", "https://chatgpt.com/", "chatgpt"), ("", "https://chat.openai.com/", "chatgpt"),
        ("", "https://www.perplexity.ai/search", "perplex"), ("", "https://copilot.microsoft.com/", "copilot"),
        ("", "https://claude.ai/chat/1", "claude"), ("", "https://t.me/vacantealmaty/5", "tg"),
        ("", "https://web.telegram.org/a/", "tg"), ("", "https://telegram.org/", "tg"),
        ("", "https://l.instagram.com/?u=x", "ig"), ("", "https://www.instagram.com/", "ig"),
        ("", "https://2gis.kz/almaty/firm/1", "2gis"), ("", "https://go.2gis.com/abc", "2gis"),
        # Приложения на Android называют себя так вместо адреса сайта
        ("", "android-app://org.telegram.messenger/", "tg"), ("", "android-app://com.instagram.android/", "ig"),
        ("", "android-app://com.google.android.googlequicksearchbox/", "google"),
        # Остальные сайты не различаем
        ("", "https://hh.kz/vacancy/1", "other"), ("", "https://notgoogle.com/", "other"),
        ("", "https://vacante.kz.example.com/", "other"),
        # Ни метки, ни чужого сайта: адрес набрали сами или перешли со своего же сайта
        ("", "", "direct"), ("", "https://vacante.kz/almaty/", "direct"), ("", "https://www.vacante.kz/", "direct"),
        ("", "https://api.vacante.kz/go/chan-5/call", "direct"), ("", "не адрес", "direct"),
    ]
    pages = open_pages(*[{"url": "https://vacante.kz/almaty/" + search, "referrer": referrer}
                         for search, referrer, _ in cases])
    assert [(search, referrer, page["via"]) for (search, referrer, _), page in zip(cases, pages)] == cases


def test_source_label_is_kept_for_the_whole_tab():
    first, inner, spoiled, closed = open_pages(
        {"url": "https://vacante.kz/almaty/", "referrer": "https://www.google.com/"},
        # Вторая страница той же вкладки: перешли по ссылке внутри сайта, в адресе чужая метка
        {"url": "https://vacante.kz/v/chan-5/?utm_source=chatgpt.com", "referrer": "https://vacante.kz/almaty/",
         "stored": "google"},
        {"url": "https://vacante.kz/", "referrer": "https://ya.ru/", "stored": "Не метка!"},
        {"url": "https://vacante.kz/", "referrer": "https://ya.ru/", "storage": False})
    # Метка лежит во вкладке под ключом «via» и видна остальному коду страницы как window.vacanteVia
    assert (first["via"], first["stored"]) == ("google", "google")
    assert (inner["via"], inner["stored"]) == ("google", "google")
    # В хранилище не метка: считаем заново. Хранилище закрыто: метка есть, просто не запоминается
    assert (spoiled["via"], spoiled["stored"]) == ("yandex", "yandex")
    assert closed["via"] == "yandex" and closed["errors"] == []


def test_direct_button_gets_source_label_and_is_not_counted_twice():
    page, = open_pages({"url": "https://vacante.kz/v/chan-31/", "referrer": "https://www.google.com/",
                        "clicks": [{"href": GO}, {"href": GO + "&via=google"}]})
    # Метка дописывается к адресу перед переходом; вернулись кнопкой «Назад» и нажали снова — второй раз её нет
    assert page["hrefs"] == [GO + "&via=google"] * 2
    # Само нажатие сервер считает на переходе /go/: отдельно его не отправляем
    assert page["beacons"] == [] and page["fetches"] == []
    assert page["ym"] == [[77, "reachGoal", "contact", {"kind": "wa", "via": "google"}],
                          [77, "params", {"contact": "wa"}]] * 2


def test_reply_button_press_goes_to_server_counter_and_metrika():
    url = "https://vacante.kz/v/hh-5/?utm_source=chatgpt.com"
    page, no_beacon, refused = open_pages(
        # Колесо мыши открывает ссылку в новой вкладке: это тоже нажатие. Правая кнопка открывает меню
        {"url": url, "clicks": [HH, APP, {**HH, "type": "auxclick", "button": 1}, {**HH, "type": "auxclick", "button": 2}]},
        {"url": url, "beacon": "none", "clicks": [HH]},
        {"url": url, "beacon": "refused", "clicks": [HH]})
    body = '{"id":"hh-5","kind":"%s","via":"chatgpt","s":"web"}'
    # В счётчик уходят вакансия, вид кнопки и метка источника: строкой, без имён, cookie и идентификаторов
    assert page["beacons"] == [[API + "/hit", body % "hh"], [API + "/hit", body % "app"], [API + "/hit", body % "hh"]]
    assert page["fetches"] == [] and page["hrefs"] == [HH["href"], APP["href"], HH["href"], HH["href"]]
    contact = [[77, "reachGoal", "contact", {"kind": "hh", "via": "chatgpt"}], [77, "params", {"contact": "hh"}]]
    assert page["ym"] == contact + [[77, "reachGoal", "to_app"], [77, "params", {"to_app": "app"}]] + contact
    # Браузер без sendBeacon или с переполненной очередью: то же самое уходит через fetch, ответа не ждём
    for other in (no_beacon, refused):
        assert other["fetches"] == [[API + "/hit", {"method": "POST", "body": body % "hh", "keepalive": True,
                                                    "mode": "no-cors"}]]
        assert other["ym"] == contact and other["errors"] == []


def test_every_reply_kind_has_its_metrika_goal():
    kinds = ["take", "bot", "hh", "olx", "orig", "app", "pf"]
    page, = open_pages({"url": "https://vacante.kz/v/chan-5/", "referrer": "https://t.me/vacantealmaty/7",
                        "clicks": [{"href": "https://example.com/", "data": {"kind": k, "id": "chan-5"}} for k in kinds]})
    assert [json.loads(body)["kind"] for _, body in page["beacons"]] == kinds
    goals = [call[2:] for call in page["ym"] if call[1] == "reachGoal"]
    # Отклик мимо приложения — цель «contact» с видом кнопки и источником, переход в приложение — «to_app»
    assert goals == [["contact", {"kind": k, "via": "tg"}] for k in kinds[:5]] + [["to_app"], ["to_app"]]
    assert [call[2] for call in page["ym"] if call[1] == "params"] == (
        [{"contact": k} for k in kinds[:5]] + [{"to_app": "app"}, {"to_app": "pf"}])


def test_post_form_link_gets_source_label_and_metrika_goal():
    page, = open_pages({"url": "https://vacante.kz/almaty/", "referrer": "https://yandex.kz/search/",
                        "clicks": [{"href": POST}, {"href": POST + "&via=yandex"}]})
    # Метку форма размещения передаст счётчику своих шагов
    assert page["hrefs"] == [POST + "&via=yandex"] * 2
    assert page["ym"] == [[77, "reachGoal", "post_form"], [77, "params", {"post_form": "site_header"}]] * 2
    assert page["beacons"] == [] and page["fetches"] == []


def test_counters_never_break_the_page():
    clicks = [HH, {"href": GO}, {"href": POST}, {"href": "https://vacante.kz/v/chan-5/"}, {}]
    hrefs = [HH["href"], GO + "&via=direct", POST + "&via=direct", "https://vacante.kz/v/chan-5/", None]
    blocked, broken, bare = open_pages(
        {"url": "https://vacante.kz/", "ym": "none", "clicks": clicks},  # Метрику закрыл блокировщик
        {"url": "https://vacante.kz/", "ym": "broken", "clicks": clicks},
        # Сборка без сервера и без Метрики: отправлять нажатия некуда
        {"url": "https://vacante.kz/", "api": "", "metrika": "", "clicks": clicks})
    # Метрики нет или она падает: ссылки получают метку, нажатие уходит на сервер, страница работает
    for page in (blocked, broken):
        assert page["errors"] == [] and page["ym"] == [] and page["hrefs"] == hrefs
        assert [json.loads(body) for _, body in page["beacons"]] == [{"id": "hh-5", "kind": "hh", "via": "direct", "s": "web"}]
    # Обычные ссылки и нажатия мимо ссылок скрипт не трогает нигде
    assert bare["errors"] == [] and bare["ym"] == [] and bare["beacons"] == [] and bare["fetches"] == []
    assert bare["hrefs"] == [HH["href"], GO, POST + "&via=direct", "https://vacante.kz/v/chan-5/", None]


def test_list_filters_keep_utm_marks_in_address(tmp_path):
    raw = RawPost("telegram", "chan", 15, "https://t.me/chan/15", "Требуется повар, 300 000 тг",
                  datetime(2026, 10, 27, tzinfo=timezone.utc), "almaty")
    save_vacancies(tmp_path / "data", [parse_post(raw)])
    site.build(tmp_path / "data", tmp_path / "public", now=datetime(2026, 10, 27, tzinfo=timezone.utc))
    page = (tmp_path / "public" / "almaty" / "index.html").read_text("utf-8")
    save = page[page.index("function save() {"):page.index("function render(")]
    telegram = "?utm_source=telegram&utm_medium=bot&utm_campaign=sub&utm_content=almaty"
    cases = [
        # Пришли из ChatGPT, фильтры не трогали: метка остаётся в адресе, её увидят Метрика и via.js
        ({"url": "https://vacante.kz/almaty/?utm_source=chatgpt.com"}, "?utm_source=chatgpt.com"),
        # Пришли из подборки бота и выбрали сферу и условия: свои параметры идут после чужих
        ({"url": "https://vacante.kz/almaty/" + telegram, "cat": "horeca", "perks": ["Питание", "salary"]},
         telegram + "&cat=horeca&perks=%D0%9F%D0%B8%D1%82%D0%B0%D0%BD%D0%B8%D0%B5%2Csalary"),
        # Свои параметры заменяются и убираются, чужой yclid и якорь остаются
        ({"url": "https://vacante.kz/almaty/?q=%D0%B1%D0%B0%D1%80&sort=pay&yclid=7&pay=300000#list", "q": " повар ",
          "sort": "new", "pay": "0"}, "?yclid=7&q=%D0%BF%D0%BE%D0%B2%D0%B0%D1%80#list"),
        ({"url": "https://vacante.kz/almaty/?sort=pay", "sort": "pay", "fresh": "1", "pay": "300000"},
         "?sort=pay&fresh=1&pay=300000"),
        # Параметров нет совсем: адрес страницы как был
        ({"url": "https://vacante.kz/almaty/"}, "/almaty/"), ({"url": "https://vacante.kz/almaty/#list"}, "/almaty/#list"),
    ]
    assert node(SAVE, {"save": save, "pages": [page for page, _ in cases]}) == [address for _, address in cases]

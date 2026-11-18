import json
from datetime import datetime, timezone

from vacante.models import RawPost
from vacante.parse import parse_post
from vacante.site import build as site
from vacante.site.build import build, money, plural
from vacante.store import save_vacancies


def test_build_writes_city_category_and_vacancy_pages(tmp_path):
    raw = RawPost("telegram", "chan", 5, "https://t.me/chan/5",
                  "Ресторан Ramen77 ищет официанта, 14 000–18 000 тг в день, 2/2, питание",
                  datetime(2026, 10, 27, tzinfo=timezone.utc), "almaty")
    save_vacancies(tmp_path / "data", [parse_post(raw)])
    out = tmp_path / "public"
    count = build(tmp_path / "data", out, "https://vacante.kz", now=datetime(2026, 10, 27, 12, tzinfo=timezone.utc))
    # главная, город, город+сфера, вакансия, конфиденциальность, «Работодателям» и две страницы «Подработка и смены» (оплата за смену):
    # по-русски и по-казахски
    assert count == 16
    page = (out / "v" / "chan-5" / "index.html").read_text("utf-8")
    assert "Официант" in page and "14 000 – 18 000 ₸/день" in page
    assert 'href="https://t.me/chan/5"' in page
    # Главная кнопка ведёт в приложение на эту вакансию; оригинал объявления остаётся второй ссылкой
    assert 'class="apply" href="https://t.me/vacantekz_bot?startapp=sweb_a_almaty_chan-5"' in page
    assert 'class="apply second" href="https://t.me/chan/5"' in page
    assert page.index('startapp=sweb_a_almaty_chan-5') < page.index('class="apply second"')
    assert '"@type": "JobPosting"' in page
    assert (out / "almaty" / "horeca" / "index.html").exists()
    assert "https://vacante.kz/almaty/" in (out / "sitemap.xml").read_text("utf-8")
    assert (out / "CNAME").read_text().strip() == "vacante.kz"


def test_links_follow_base_path_on_github_pages(tmp_path):
    raw = RawPost("telegram", "chan", 6, "https://t.me/chan/6", "Требуется повар, 300 000 тг",
                  datetime(2026, 10, 27, tzinfo=timezone.utc), "astana")
    save_vacancies(tmp_path / "data", [parse_post(raw)])
    out = tmp_path / "public"
    build(tmp_path / "data", out, "https://mirasito.github.io/vacante", now=datetime(2026, 10, 27, tzinfo=timezone.utc))
    home = (out / "index.html").read_text("utf-8")
    assert 'href="/vacante/static/style.css"' in home
    assert 'href="/vacante/v/chan-6/"' in home
    assert 'href="/v/' not in home
    assert not (out / "CNAME").exists()


def test_vacancy_page_shows_address_with_2gis(tmp_path):
    raw = RawPost("telegram", "chan", 7, "https://t.me/chan/7", "Требуется повар, 300 000 тг\n📍 Адрес: ул. Сыганак, 2",
                  datetime(2026, 10, 27, tzinfo=timezone.utc), "astana")
    save_vacancies(tmp_path / "data", [parse_post(raw)])
    build(tmp_path / "data", tmp_path / "public", now=datetime(2026, 10, 27, tzinfo=timezone.utc))
    page = (tmp_path / "public" / "v" / "chan-7" / "index.html").read_text("utf-8")
    assert "<dt>Адрес</dt><dd>ул. Сыганак, 2" in page
    assert 'href="https://2gis.kz/astana/search/%D1%83%D0%BB.%20%D0%A1%D1%8B%D0%B3%D0%B0%D0%BD%D0%B0%D0%BA%2C%202"' in page


def test_list_has_filters_and_counts_in_russian(tmp_path):
    raw = RawPost("telegram", "chan", 8, "https://t.me/chan/8",
                  "Ресторан Ramen77 ищет официанта, 14 000–18 000 тг в день, без опыта, питание",
                  datetime(2026, 10, 27, tzinfo=timezone.utc), "almaty")
    save_vacancies(tmp_path / "data", [parse_post(raw)])
    build(tmp_path / "data", tmp_path / "public", now=datetime(2026, 10, 27, tzinfo=timezone.utc))
    home = (tmp_path / "public" / "index.html").read_text("utf-8")
    assert "<title>Вакансии — 1 вакансия | vacante.kz</title>" in home
    assert 'data-pay="396000"' in home  # 18 000 за смену × 22 смены
    assert 'data-perks="Питание|Без опыта|Смены и подработка"' in home  # оплата за смену
    assert 'data-perk="Без опыта"' in home and 'value="300000"' in home
    # Сортировка, свежесть и сфера; оплата за смену видна и в пересчёте на месяц
    assert 'id="sort"' in home and 'id="fresh"' in home and '<option value="horeca" data-label="Кафе и рестораны">' in home
    assert 'data-posted="2026-10-27T00:00:00+00:00"' in home
    assert f'<span class="pill monthly">≈ {money(308000)} – {money(396000)} ₸/мес</span>' in home
    city = (tmp_path / "public" / "almaty" / "index.html").read_text("utf-8")
    assert 'id="cat"' in city and 'href="/almaty/horeca/">Кафе и рестораны <small>1</small>' in city
    category = (tmp_path / "public" / "almaty" / "horeca" / "index.html").read_text("utf-8")
    assert 'id="cat"' not in category and 'id="fresh"' in category
    assert [plural(n, "вакансия", "вакансии", "вакансий") for n in (1, 3, 5, 11, 21, 522)] == [
        "вакансия", "вакансии", "вакансий", "вакансий", "вакансия", "вакансии"]


def test_search_tags_and_metrika_only_when_set(tmp_path, monkeypatch):
    raw = RawPost("telegram", "chan", 9, "https://t.me/chan/9", "Требуется повар, 300 000 тг",
                  datetime(2026, 10, 27, tzinfo=timezone.utc), "astana")
    save_vacancies(tmp_path / "data", [parse_post(raw)])
    monkeypatch.setattr(site, "SITE_TAGS", {"google_verification": "", "yandex_verification": "", "metrika_id": ""})
    build(tmp_path / "data", tmp_path / "a", now=datetime(2026, 10, 27, tzinfo=timezone.utc))
    plain = (tmp_path / "a" / "index.html").read_text("utf-8")
    assert "verification" not in plain and "mc.yandex.ru" not in plain
    monkeypatch.setattr(site, "SITE_TAGS", {"google_verification": "g123", "yandex_verification": "y456",
                                            "metrika_id": "98765432"})
    build(tmp_path / "data", tmp_path / "b", now=datetime(2026, 10, 27, tzinfo=timezone.utc))
    home = (tmp_path / "b" / "index.html").read_text("utf-8")
    assert '<meta name="google-site-verification" content="g123">' in home
    assert '<meta name="yandex-verification" content="y456">' in home
    assert 'ym(98765432, "init"' in home


def test_list_links_to_more_vacancies_elsewhere(tmp_path):
    raw = RawPost("telegram", "chan", 8, "https://t.me/chan/8", "Требуется официант, 300 000 тг",
                  datetime(2026, 10, 27, tzinfo=timezone.utc), "almaty")
    save_vacancies(tmp_path / "data", [parse_post(raw)])
    out = tmp_path / "public"
    build(tmp_path / "data", out, now=datetime(2026, 10, 27, tzinfo=timezone.utc))
    city = (out / "almaty" / "index.html").read_text("utf-8")
    assert 'href="https://hh.kz/search/vacancy?area=160"' in city
    assert 'href="https://www.olx.kz/rabota/"' in city
    horeca = (out / "almaty" / "horeca" / "index.html").read_text("utf-8")
    assert "area=160&amp;text=%D0%BE%D1%84" in horeca
    assert "Разместите вакансию через бота" in city and "900 ₸" not in city
    assert site.more_links("astana")[1] == ("OLX", "https://www.olx.kz/rabota/astana/")
    assert site.more_links(None)[0] == ("hh.kz", "https://hh.kz/search/vacancy?area=40")


def test_kazakh_version_with_language_switch_and_hreflang(tmp_path):
    raw = RawPost("telegram", "chan", 9, "https://t.me/chan/9",
                  "Ресторан Ramen77 ищет официанта, 14 000–18 000 тг в день, без опыта, питание",
                  datetime(2026, 10, 27, tzinfo=timezone.utc), "almaty")
    save_vacancies(tmp_path / "data", [parse_post(raw)])
    out = tmp_path / "public"
    build(tmp_path / "data", out, now=datetime(2026, 10, 27, tzinfo=timezone.utc))
    kk = (out / "kk" / "almaty" / "index.html").read_text("utf-8")
    assert '<html lang="kk">' in kk and "Алматыдағы жұмыс" in kk
    assert "<h3>Даяшы</h3>" in kk and "14\xa0000 – 18\xa0000 ₸/күн" in kk
    assert "≈ 308\xa0000 – 396\xa0000 ₸/ай" in kk
    assert 'href="/kk/v/chan-9/"' in kk and "Тәжірибесіз" in kk and 'data-perk="Без опыта"' in kk
    assert '<link rel="alternate" hreflang="ru" href="https://vacante.kz/almaty/">' in kk
    assert '<a href="/almaty/" hreflang="ru"' in kk
    ru = (out / "almaty" / "index.html").read_text("utf-8")
    assert '<link rel="alternate" hreflang="kk" href="https://vacante.kz/kk/almaty/">' in ru
    assert "Работа в Алматы" in ru and "<h3>Официант</h3>" in ru
    page = (out / "kk" / "v" / "chan-9" / "index.html").read_text("utf-8")
    assert "<h1>Даяшы</h1>" in page and "Ramen77" in page and "JobPosting" not in page
    assert (out / "kk" / "almaty" / "horeca" / "index.html").exists()
    assert "Кафе мен мейрамханалар: Алматыдағы жұмыс" in (out / "kk" / "almaty" / "horeca" / "index.html").read_text()
    sitemap = (out / "sitemap.xml").read_text("utf-8")
    assert "<loc>https://vacante.kz/kk/</loc>" in sitemap
    assert '<xhtml:link rel="alternate" hreflang="kk" href="https://vacante.kz/kk/v/chan-9/"/>' in sitemap


def test_kazakh_title_from_hh(tmp_path):
    from vacante.sources import hh
    v = hh.to_vacancy({"id": "5", "name": "Сату менеджер/Менеджер по продажам", "area": {"name": "Алматы"},
                       "published_at": "2026-10-28T10:00:00+0500", "alternate_url": "https://hh.kz/vacancy/5",
                       "employer": {"name": "ZERFARM"}})
    save_vacancies(tmp_path / "data", [v])
    build(tmp_path / "data", tmp_path / "public", now=datetime(2026, 10, 28, tzinfo=timezone.utc))
    assert "<h1>Менеджер по продажам</h1>" in (tmp_path / "public" / "v" / "hh-5" / "index.html").read_text()
    assert "<h1>Сату менеджер</h1>" in (tmp_path / "public" / "kk" / "v" / "hh-5" / "index.html").read_text()


def test_build_writes_app_feed_by_city(tmp_path):
    raw = RawPost("telegram", "chan", 9, "https://t.me/chan/9",
                  "Кофейня ищет бариста, 250 000 тг, питание, без опыта",
                  datetime(2026, 10, 27, tzinfo=timezone.utc), "astana")
    save_vacancies(tmp_path / "data", [parse_post(raw)])
    out = tmp_path / "public"
    build(tmp_path / "data", out, "https://vacante.kz", now=datetime(2026, 10, 27, 12, tzinfo=timezone.utc))
    import json
    index = json.loads((out / "app" / "data" / "index.json").read_text("utf-8"))
    assert index["cities"] == [{"slug": "astana", "name": "Астана", "name_kk": "Астана", "count": 1}]
    # Профессии для анкеты: частые в вакансиях первыми, с казахскими названиями
    assert index["roles"][0] == {"title": "Бариста", "title_kk": "Бариста", "category": "horeca",
                                 "key": site.appfeed.role_key("Бариста")}
    assert {"title": "Официант", "title_kk": "Даяшы", "category": "horeca",
            "key": site.appfeed.role_key("Официант")} in index["roles"]
    assert len({r["title"] for r in index["roles"]}) == len(index["roles"])
    feed = json.loads((out / "app" / "data" / "astana.json").read_text("utf-8"))
    card = feed["vacancies"][0]
    assert card["title"] == "Бариста" and card["url"] == "https://vacante.kz/v/chan-9/"
    assert card["pay"].replace("\xa0", " ") == "от 250 000 ₸/мес" and "Тамақ" in card["perks_kk"]
    # Число для фильтра «Зарплата от»
    assert card["pay_month"] == 250000


def test_app_feed_writes_role_files_beyond_city_feed(tmp_path, monkeypatch):
    import json
    from vacante.site import appfeed
    monkeypatch.setattr(appfeed, "PER_CITY", 2)
    now = datetime(2026, 10, 27, 12, tzinfo=timezone.utc)
    texts = ["Требуется повар, 300 000 тг", "Требуется кассир", "Требуется официант", "Требуется официант, 200 000 тг",
             "Требуется бармен-официант"]
    vs = [parse_post(RawPost("telegram", "chan", i, f"https://t.me/chan/{i}", t, now, "almaty"))
          for i, t in enumerate(texts)]
    appfeed.write(tmp_path, vs, "https://vacante.kz", now, {})
    data = tmp_path / "app" / "data"
    city = json.loads((data / "almaty.json").read_text("utf-8"))
    assert len(city["vacancies"]) == 2 and city["total"] == 5 and city["pages"] == 3
    # Остальные страницами: p2 и p3, вместе со страницей города все 5 без повторов
    rest = [v["id"] for n in (2, 3) for v in json.loads((data / "almaty" / f"p{n}.json").read_text("utf-8"))["vacancies"]]
    assert sorted(rest + [v["id"] for v in city["vacancies"]]) == sorted(v.id for v in vs)
    # Официанты дальше первых двух: файл профессии со всеми ними; повар и кассир уже в ленте, файла нет
    waiters = json.loads((data / "almaty" / f"{appfeed.role_key('Официант')}.json").read_text("utf-8"))
    assert waiters["role"] == "Официант" and len(waiters["vacancies"]) >= 2
    assert all("Официант" in v["title"].split(", ") for v in waiters["vacancies"])
    assert not (data / "almaty" / f"{appfeed.role_key('Повар')}.json").exists()


def test_privacy_page_in_both_languages_and_linked_from_footer(tmp_path):
    raw = RawPost("telegram", "chan", 10, "https://t.me/chan/10", "Требуется повар, 300 000 тг",
                  datetime(2026, 10, 27, tzinfo=timezone.utc), "astana")
    save_vacancies(tmp_path / "data", [parse_post(raw)])
    out = tmp_path / "public"
    build(tmp_path / "data", out, "https://vacante.kz", now=datetime(2026, 10, 27, 12, tzinfo=timezone.utc))
    ru = (out / "privacy" / "index.html").read_text("utf-8")
    kk = (out / "kk" / "privacy" / "index.html").read_text("utf-8")
    assert "<h1>Политика конфиденциальности</h1>" in ru and "только на вашем устройстве" in ru
    assert "<h1>Құпиялылық саясаты</h1>" in kk and '<html lang="kk">' in kk
    # Профиль соискателя хранится на сервере в Казахстане, а не на устройстве
    assert "<h2>Профиль соискателя</h2>" in ru and "на сервере Vacante в Казахстане" in ru
    assert "<h2>Үміткер профилі</h2>" in kk and "Қазақстандағы Vacante серверінде" in kk
    # Видеокружок: что хранится и как его убрать
    assert "Видеокружок до минуты" in ru and "«Удалить кружок»" in ru
    assert "бейнехабарды бот чатында" in kk and "«Бейнехабарды жою»" in kk
    # Фото и дом: метаданные фото удаляются, дом — округлённая точка, которую работодатель не видит
    assert "место съёмки, модель телефона и дата (EXIF) удаляются" in ru and "«Удалить фото»" in ru
    assert "округлённая до 0,005° (300–500 метров), без адреса" in ru and "Работодатели точку не видят" in ru
    assert "(EXIF)" in kk and "«Фотоны жою»" in kk and "0,005°-қа дейін (300–500 метр)" in kk
    # Фото и кружок в превью ссылки: только по галочке, превью и копия кружка остаются в чатах и у Telegram
    assert "«Показывать фото и кружок в превью ссылки»" in ru and "Имени и других данных анкеты в превью нет" in ru
    assert "Telegram скачивает картинку и кружок на свои серверы" in ru
    assert "«Сілтеме превьюінде фото мен бейнехабарды көрсету»" in kk and "Telegram-да қалады" in kk
    # Отклики: номер работодателя берётся из открытого поста и хранится на сервере в Казахстане,
    # на страницах сайта и в открытых данных его нет; нажатия на кнопки связи считаются без имён
    assert "<h2>Отклики</h2>" in ru and "храним на сервере в Казахстане" in ru and "работает 60 дней" in ru
    assert "На страницах сайта и в открытых данных номеров нет" in ru and "не записываем, кто нажал" in ru
    assert "Мы его не сохраняем" not in ru and "Біз оны сақтамаймыз" not in kk
    assert "<h2>Өтінімдер</h2>" in kk and "Қазақстандағы серверде сақтаймыз" in kk and "60 күн жұмыс істейді" in kk
    # Напоминания: не больше двух в день с 9 до 21
    assert "<h2>Напоминания</h2>" in ru and "не больше двух напоминаний в день" in ru
    assert "<h2>Еске салғыштар</h2>" in kk and "күніне екіден көп емес" in kk
    # Цель недели и достижения: видит только сам человек, рейтинга нет
    assert "<h2>Цель недели и достижения</h2>" in ru and "Рейтингов и сравнения с другими людьми нет" in ru
    assert "<h2>Апта мақсаты және жетістіктер</h2>" in kk and "Рейтинг және басқа адамдармен салыстыру жоқ" in kk
    home = (out / "index.html").read_text("utf-8")
    assert 'href="/privacy/"' in home and 'href="/app/"' in home
    assert 'href="/kk/privacy/"' in (out / "kk" / "index.html").read_text("utf-8")


def test_employers_page_linked_from_header_and_feed_has_channels(tmp_path):
    raw = RawPost("telegram", "chan", 11, "https://t.me/chan/11", "Требуется повар, 300 000 тг",
                  datetime(2026, 10, 27, tzinfo=timezone.utc), "astana")
    save_vacancies(tmp_path / "data", [parse_post(raw)])
    out = tmp_path / "public"
    build(tmp_path / "data", out, "https://vacante.kz", now=datetime(2026, 10, 27, 12, tzinfo=timezone.utc))
    ru = (out / "rabotodatelyam" / "index.html").read_text("utf-8")
    kk = (out / "kk" / "rabotodatelyam" / "index.html").read_text("utf-8")
    assert "<h1>Найдите сотрудников через vacante.kz</h1>" in ru and "https://t.me/vacantekz_bot?start=post" in ru
    assert 'href="https://t.me/vacanteastana">Астана</a>' in ru
    assert "<h1>Қызметкерлерді vacante.kz арқылы табыңыз</h1>" in kk
    # Цены тарифов берутся из bot/wrangler.toml
    prices = site.employer_prices()
    assert prices and f"{site.money(prices['pro'])} ₸" in ru and f"{site.money(prices['post'])} ₸" in ru
    assert "Пакеты Про:" in ru and "Про пакеттері:" in kk
    assert 'class="post-job" href="/rabotodatelyam/"' in (out / "index.html").read_text("utf-8")
    assert 'class="post-job" href="/kk/rabotodatelyam/"' in (out / "kk" / "index.html").read_text("utf-8")
    # Бот по feed.json пишет работодателю, в каком канале выйдет вакансия
    feed = json.loads((out / "feed.json").read_text("utf-8"))
    assert feed["channels"]["astana"] == "@vacanteastana" and feed["channels"]["almaty"] == "@vacantealmaty"


def test_vacancy_page_has_whatsapp_and_call_buttons_when_post_has_contacts(tmp_path):
    raw = RawPost("telegram", "chan", 31, "https://t.me/chan/31", "Требуется повар, 300 000 тг",
                  datetime(2026, 10, 27, tzinfo=timezone.utc), "almaty")
    from dataclasses import replace
    save_vacancies(tmp_path / "data", [replace(parse_post(raw), contact=["whatsapp", "phone"])])
    build(tmp_path / "data", tmp_path / "public", "https://vacante.kz", now=datetime(2026, 10, 27, 12, tzinfo=timezone.utc))
    page = (tmp_path / "public" / "v" / "chan-31" / "index.html").read_text("utf-8")
    # Кнопки сразу ведут к работодателю через сервер, где хранится номер; на самой странице номера нет
    assert '<a class="apply" href="https://api.vacante.kz/go/chan-31/wa?s=web&amp;t=%D0%9F%D0%BE%D0%B2%D0%B0%D1%80" rel="nofollow">💬 Написать в WhatsApp</a>' in page
    assert '<a class="apply" href="https://api.vacante.kz/go/chan-31/call?s=web&amp;t=%D0%9F%D0%BE%D0%B2%D0%B0%D1%80" rel="nofollow">📞 Позвонить</a>' in page
    assert "Откликнуться в приложении" not in page  # есть способы связи: общая кнопка не нужна
    assert "wa.me" not in page and "tel:" not in page
    # Профиль можно сделать и придя с сайта: кнопка ведёт в приложение на эту вакансию
    assert '<a class="apply second" href="https://t.me/vacantekz_bot?startapp=swebpf_a_almaty_chan-31" rel="nofollow">👤 Откликнуться с профилем</a>' in page
    assert "С профилем отвечают охотнее" in page
    kk = (tmp_path / "public" / "kk" / "v" / "chan-31" / "index.html").read_text("utf-8")
    assert "WhatsApp-қа жазу" in kk and "Қоңырау шалу" in kk


def test_long_lists_load_rest_from_city_cards_and_profession_pages(tmp_path, monkeypatch):
    import json
    monkeypatch.setattr(site, "PAGE_SIZE", 2)
    posts = [RawPost("telegram", "chan", i, f"https://t.me/chan/{i}", f"Требуется официант в кафе Ромашка, 250 000 тг, №{i}",
                     datetime(2026, 10, 27, i, tzinfo=timezone.utc), "almaty") for i in range(1, 5)]
    save_vacancies(tmp_path / "data", [parse_post(p) for p in posts])
    out = tmp_path / "public"
    build(tmp_path / "data", out, "https://vacante.kz", now=datetime(2026, 10, 27, 12, tzinfo=timezone.utc))
    city = (out / "almaty" / "index.html").read_text("utf-8")
    assert city.count('<a class="card') == 2 and 'data-src="/almaty/cards.json"' in city and 'id="more"' in city
    rows = json.loads((out / "almaty" / "cards.json").read_text("utf-8"))
    assert len(rows) == 4 and "data-search" not in rows[0][1]
    # Профессия берёт карточки из файла города по своим id
    prof = (out / "almaty" / "oficiant" / "index.html").read_text("utf-8")
    assert "Официант: вакансии в Алматы" in prof and 'data-src="/almaty/cards.json"' in prof and "data-ids=" in prof
    assert not (out / "almaty" / "oficiant" / "cards.json").exists()
    assert "Даяшы: Алматыдағы жұмыс" in (out / "kk" / "almaty" / "oficiant" / "index.html").read_text("utf-8")
    assert "<loc>https://vacante.kz/almaty/oficiant/</loc>" in (out / "sitemap.xml").read_text("utf-8")
    page = (out / "v" / "chan-1" / "index.html").read_text("utf-8")
    assert '"BreadcrumbList"' in page and 'href="/almaty/oficiant/"' in page and 'class="similar"' in page
    assert '<meta property="og:title"' in page
    assert (out / f"{site.INDEXNOW_KEY}.txt").read_text() == site.INDEXNOW_KEY


def test_job_posting_escapes_text_and_adds_address():
    from vacante.models import Vacancy
    v = Vacancy(id="c-1", title="Повар", category="horeca", city="astana", salary_min=None, salary_max=None,
                salary_period=None, schedule="5/2", perks=[], employer="Кафе", text="Повар <нужен>\nсрочно",
                source="telegram", source_url="https://t.me/c/1", posted_at="2026-11-01T10:00:00+00:00",
                fingerprint="x", address="ул. Сыганак, 2")
    import json
    data = json.loads(site.job_posting_ld(v, "https://vacante.kz"))
    assert data["description"] == "Повар &lt;нужен&gt;<br>срочно"
    assert data["jobLocation"]["address"]["streetAddress"] == "ул. Сыганак, 2" and data["workHours"] == "5/2"


def test_search_ping_sends_only_new_urls_and_own_vacancies_to_google():
    from vacante import searchping
    old = "<url><loc>https://vacante.kz/</loc></url><url><loc>https://vacante.kz/v/a-1/</loc></url>"
    new = old + "".join(f"<url><loc>https://vacante.kz/{p}/</loc></url>" for p in ["v/a-2", "kk/v/a-2", "v/hh-5"])
    urls = searchping.new_urls(old, new)
    assert urls == ["https://vacante.kz/v/a-2/", "https://vacante.kz/kk/v/a-2/", "https://vacante.kz/v/hh-5/"]
    assert searchping.google_order(urls) == ["https://vacante.kz/v/a-2/"]

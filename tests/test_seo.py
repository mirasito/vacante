"""Страницы для поиска: срок объявления в разметке, снятые адреса для IndexNow."""

import inspect
import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import httpx

from vacante import collect, direct, searchping, shifts
from vacante.models import RawPost
from vacante.parse import CITIES, parse_post
from vacante.site import build as site
from vacante.site import i18n
from vacante.site.build import build
from vacante.store import MAX_AGE_DAYS, save_vacancies

NOW = datetime(2026, 10, 27, 12, tzinfo=timezone.utc)


def post(post_id: int, text: str, city: str | None = "almaty", hours_ago: float = 3, channel: str = "chan"):
    """Вакансия из поста канала, опубликованного hours_ago часов назад."""
    raw = RawPost("telegram", channel, post_id, f"https://t.me/{channel}/{post_id}", text,
                  NOW - timedelta(hours=hours_ago), city)
    return parse_post(raw)


def test_job_posting_is_valid_while_the_page_lives():
    """validThrough — день, когда страница уйдёт с сайта: тот же срок, что у сбора, а не 30 дней."""
    v = replace(post(1, "Кафе «Зерно» ищет официанта, 250 000 тг"), employer="Зерно",
                posted_at="2026-10-27T09:00:00+00:00")
    assert MAX_AGE_DAYS == 14 and inspect.signature(collect.run).parameters["max_age_days"].default == MAX_AGE_DAYS
    assert json.loads(site.job_posting_ld(v, "https://vacante.kz"))["validThrough"] == "2026-11-10T09:00:00+00:00"
    # Оплаченное «🔥 Срочно» держит вакансию на сайте дольше срока (store.expire): объявление действует до его конца
    top = replace(v, top_until="2026-11-20T10:00:00+00:00")
    assert json.loads(site.job_posting_ld(top, "https://vacante.kz"))["validThrough"] == "2026-11-20T10:00:00+00:00"
    short = replace(v, top_until="2026-10-30T10:00:00+00:00")
    assert json.loads(site.job_posting_ld(short, "https://vacante.kz"))["validThrough"] == "2026-11-10T09:00:00+00:00"


def test_shift_for_a_day_is_valid_until_that_day_ends():
    """Смена на конкретный день уходит с сайта, когда день прошёл (время Казахстана), а не через две недели."""
    shift = direct.to_vacancy({"id": 9, "kind": "shift", "city": "almaty", "title": "официант", "company": "Кафе «Зерно»",
                               "salary": "12 000 ₸ за смену", "approved_at": "2026-11-06 07:00:00",
                               "shift_date": "2026-11-07", "shift_start": "10:00", "shift_end": "22:00", "need": 3})
    data = json.loads(site.job_posting_ld(shift, "https://vacante.kz"))
    assert data["validThrough"] == "2026-11-08T00:00:00+05:00" and data["datePosted"] == "2026-11-06"


def test_search_ping_records_removed_urls_for_indexnow_only(tmp_path, monkeypatch, capsys):
    """diff пишет новые адреса и после пустой строки снятые; send отдаёт IndexNow и те и другие, Google — только новые."""
    url = lambda *paths: "".join(f"<url><loc>https://vacante.kz/{p}</loc></url>" for p in paths)  # noqa: E731
    (tmp_path / "old.xml").write_text(url("", "v/a-1/", "kk/v/a-1/", "almaty/povar/"), "utf-8")
    (tmp_path / "new.xml").write_text(url("", "v/a-2/", "kk/v/a-2/", "v/hh-5/"), "utf-8")
    out = tmp_path / "urls.txt"
    searchping.main(["diff", str(tmp_path / "old.xml"), str(tmp_path / "new.xml"), str(out)])
    assert "новых адресов: 3, снятых: 3" in capsys.readouterr().out
    assert out.read_text("utf-8") == ("https://vacante.kz/v/a-2/\nhttps://vacante.kz/kk/v/a-2/\nhttps://vacante.kz/v/hh-5/\n\n"
                                      "https://vacante.kz/v/a-1/\nhttps://vacante.kz/kk/v/a-1/\nhttps://vacante.kz/almaty/povar/")
    sent = {}

    def record(name: str):
        def step(client, urls):
            sent[name] = urls
            return f"{name}: {len(urls)}"
        return step

    monkeypatch.setattr(searchping, "indexnow", record("indexnow"))
    monkeypatch.setattr(searchping, "google_index", record("google"))
    searchping.main(["send", str(out)])
    assert sent["indexnow"] == ["https://vacante.kz/v/a-2/", "https://vacante.kz/kk/v/a-2/", "https://vacante.kz/v/hh-5/",
                                "https://vacante.kz/v/a-1/", "https://vacante.kz/kk/v/a-1/", "https://vacante.kz/almaty/povar/"]
    assert sent["google"] == ["https://vacante.kz/v/a-2/", "https://vacante.kz/kk/v/a-2/", "https://vacante.kz/v/hh-5/"]
    assert searchping.google_order(sent["google"]) == ["https://vacante.kz/v/a-2/"]


def test_search_ping_file_stays_compatible_both_ways(tmp_path, capsys):
    """Без снятых адресов файл такой же, как раньше; файл прошлого формата читается как «все адреса новые»."""
    assert searchping.join_urls(["https://vacante.kz/v/a-2/", "https://vacante.kz/v/a-3/"], []) == (
        "https://vacante.kz/v/a-2/\nhttps://vacante.kz/v/a-3/")
    assert searchping.split_urls("https://vacante.kz/v/a-2/\nhttps://vacante.kz/v/a-3/") == (
        ["https://vacante.kz/v/a-2/", "https://vacante.kz/v/a-3/"], [])
    assert searchping.split_urls("") == ([], [])
    # Только снятые: файл не пуст (шаг отправки в update.yml пропускает пустой файл), новых в нём нет
    only_gone = searchping.join_urls([], ["https://vacante.kz/v/a-1/"])
    assert only_gone.strip() and searchping.split_urls(only_gone) == ([], ["https://vacante.kz/v/a-1/"])
    # Прошлая версия send читала файл как text.split(): в новом формате это по-прежнему только адреса сайта
    both = searchping.join_urls(["https://vacante.kz/v/a-2/"], ["https://vacante.kz/v/a-1/"])
    assert both.split() == ["https://vacante.kz/v/a-2/", "https://vacante.kz/v/a-1/"]
    # Прошлой карты сайта нет (не скачалась): отправлять нечего, снятым ничего не считаем
    (tmp_path / "new.xml").write_text("<url><loc>https://vacante.kz/</loc></url>", "utf-8")
    searchping.main(["diff", str(tmp_path / "нет.xml"), str(tmp_path / "new.xml"), str(tmp_path / "urls.txt")])
    assert (tmp_path / "urls.txt").read_text("utf-8") == "" and "прошлой карты сайта нет" in capsys.readouterr().out


def test_indexnow_keeps_the_request_limit_and_new_urls_go_first():
    """В один запрос IndexNow идёт не больше 10 000 адресов: сначала новые, снятые — на оставшееся место."""
    new = [f"https://vacante.kz/v/a-{i}/" for i in range(9_998)]
    gone = [f"https://vacante.kz/v/b-{i}/" for i in range(5)]
    seen = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(202)

    with httpx.Client(transport=httpx.MockTransport(answer)) as client:
        assert searchping.indexnow(client, new + gone) == "IndexNow: 10000 адресов, ответ 202"
        assert searchping.indexnow(client, []) == "IndexNow: новых и снятых адресов нет"
    assert len(seen) == 1 and seen[0]["host"] == "vacante.kz" and seen[0]["key"] == site.INDEXNOW_KEY
    assert seen[0]["urlList"] == new + gone[:2]


def paid(post_id: int, amount: int, period: str = "month", city: str = "almaty", **fields):
    """Вакансия официанта с оплатой amount за period (месяц или смену)."""
    return replace(post(post_id, "Кафе ищет официанта", city), salary_min=amount, salary_max=amount,
                   salary_period=period, **fields)


def build_site(tmp_path, vacancies, now=NOW, **kwargs):
    """Маленький сайт из данных теста: возвращает папку, куда он собран."""
    save_vacancies(tmp_path / "data", vacancies)
    out = tmp_path / "public"
    build(tmp_path / "data", out, "https://vacante.kz", now=now, **kwargs)
    return out


def test_vacancy_description_names_the_city_in_the_right_case(tmp_path):
    """«Официант в Астане», а не «в Астана»; без города «в Казахстане». По-казахски город идёт через запятую."""
    out = build_site(tmp_path, [post(1, "Кафе ищет официанта, 250 000 тг, 2/2", "astana"),
                                post(2, "Требуется повар, 300 000 тг", None)])
    pay = f"от {site.money(250000)} ₸/мес"
    page = (out / "v" / "chan-1" / "index.html").read_text("utf-8")
    assert f'<meta name="description" content="Официант в Астане, {pay}, график 2/2. ' in page
    assert f'<meta property="og:description" content="Официант в Астане, {pay}' in page
    assert "в Астана" not in page
    kk = (out / "kk" / "v" / "chan-1" / "index.html").read_text("utf-8")
    assert '<meta name="description" content="Даяшы, Астана, ' in kk
    nowhere = (out / "v" / "chan-2" / "index.html").read_text("utf-8")
    assert '<meta name="description" content="Повар в Казахстане, ' in nowhere and "в Казахстан," not in nowhere
    assert '<meta name="description" content="Аспаз, Қазақстан, ' in (out / "kk" / "v" / "chan-2" / "index.html").read_text("utf-8")


def test_city_page_texts_name_the_city_in_the_right_case(tmp_path):
    """На странице города «Новые вакансии в Астане…» и «Ещё вакансии в городе Астана», а не «вакансии Астана»."""
    out = build_site(tmp_path, [post(1, "Кафе ищет официанта, 250 000 тг, 2/2", "astana")])
    page = (out / "astana" / "index.html").read_text("utf-8")
    assert "Новые вакансии в Астане каждый день в Telegram →" in page
    assert "Ещё вакансии в городе Астана:" in page and "вакансии Астана" not in page
    kk = (out / "kk" / "astana" / "index.html").read_text("utf-8")
    assert "Астана: жаңа вакансиялар күн сайын Telegram-да →" in kk and "Басқа вакансиялар Астана қаласында:" in kk
    assert "Ещё вакансии:" in (out / "index.html").read_text("utf-8")  # без города фраза прежняя


def test_every_city_has_its_forms_for_both_languages():
    """Новый город в parse.CITIES без падежных форм дал бы «в Кокшетау» наугад: формы есть у каждого города."""
    assert set(site._LOCATIVE) == set(CITIES) == set(i18n.CITIES_KK) == set(i18n.CITIES_KK_IN)
    assert (site.city_in("astana"), site.city_in("astana", "kk")) == ("Астане", "Астанадағы")
    assert (site.city_in(None), site.city_in(None, "kk")) == ("Казахстане", "Қазақстандағы")


def test_home_page_says_what_the_site_is_and_for_whom(tmp_path):
    """Главная: «Работа в Казахстане» в заголовке, свои название вкладки и описание с живым числом вакансий."""
    out = build_site(tmp_path, [post(1, "Кафе ищет официанта, 250 000 тг", "astana"), post(2, "Требуется повар, 300 000 тг"),
                                post(3, "Нужен курьер, 12 000 тг за смену")])
    home = (out / "index.html").read_text("utf-8")
    assert "<h1>Работа в Казахстане</h1>" in home
    assert "<title>Работа в Казахстане: 3 вакансии — без опыта, подработка и смены | vacante.kz</title>" in home
    assert ('<meta name="description" content="vacante.kz — 3 вакансии для официантов, поваров, продавцов, курьеров '
            "и других рабочих профессий в Алматы, Астане и других городах Казахстана. Есть работа без опыта, "
            'подработка и смены. Список обновляется каждый час.">') in home
    assert '"@type": "WebSite"' in home and '"@type": "Organization"' in home  # разметка сайта осталась
    kk = (out / "kk" / "index.html").read_text("utf-8")
    assert "<h1>Қазақстандағы жұмыс</h1>" in kk
    assert "<title>Қазақстандағы жұмыс: 3 вакансия — тәжірибесіз, қосымша жұмыс және ауысымдар | vacante.kz</title>" in kk
    assert "мамандықтарына арналған 3 вакансия: Алматы, Астана және Қазақстанның басқа қалалары. " in kk
    # Остальные списки называются как раньше
    assert "<title>Работа в Астане — 1 вакансия | vacante.kz</title>" in (out / "astana" / "index.html").read_text("utf-8")
    assert "<h1>Астанадағы жұмыс</h1>" in (out / "kk" / "astana" / "index.html").read_text("utf-8")
    assert "<h1>Подработка и смены в Казахстане</h1>" in (out / shifts.SLUG / "index.html").read_text("utf-8")
    assert "<h1>Қазақстандағы қосымша жұмыс және ауысымдар</h1>" in (out / "kk" / shifts.SLUG / "index.html").read_text("utf-8")
    assert "<h1>Подработка и смены в Алматы</h1>" in (out / "almaty" / shifts.SLUG / "index.html").read_text("utf-8")
    # Пока вакансий нет, главная не обещает «0 вакансий для официантов»
    empty = (build_site(tmp_path / "empty", []) / "index.html").read_text("utf-8")
    assert "<title>Работа в Казахстане — 0 вакансий | vacante.kz</title>" in empty and "0 вакансий для" not in empty


def test_list_pages_say_how_fresh_they_are(tmp_path):
    """Под заголовком списка: когда он собран (время Казахстана) и сколько вакансий вышло за сутки и за три дня."""
    out = build_site(tmp_path, [post(1, "Кафе ищет официанта, 250 000 тг", hours_ago=2),
                                post(2, "Требуется повар, 300 000 тг", hours_ago=30),
                                post(3, "Нужен продавец, 200 000 тг", hours_ago=71),
                                post(4, "Требуется бармен, 280 000 тг", "astana", hours_ago=100),
                                post(5, "Нужен кассир, 190 000 тг", "shymkent", hours_ago=40),
                                post(6, "Требуется грузчик, 210 000 тг", "karaganda", hours_ago=1)],
                     now=NOW + timedelta(minutes=17))
    page = lambda *path: out.joinpath(*path, "index.html").read_text("utf-8")  # noqa: E731
    assert ('<h1>Работа в Казахстане</h1>\n<p class="pay-stats">Обновлено 27.10 в 17:17: 2 новые вакансии за сутки, '
            "5 за три дня.</p>") in page()
    assert "Обновлено 27.10 в 17:17: 1 новая вакансия за сутки, 3 за три дня." in page("almaty")
    assert "Обновлено 27.10 в 17:17: 1 новая вакансия за сутки, 2 за три дня." in page("almaty", "horeca")
    # Всё, что вышло за три дня, вышло за сутки: второе число не повторяем. За сутки ничего: только три дня
    assert "Обновлено 27.10 в 17:17: 1 новая вакансия за сутки.</p>" in page("karaganda")
    assert "Обновлено 27.10 в 17:17: 1 новая вакансия за три дня.</p>" in page("shymkent")
    # Новых за три дня нет: строки нет вовсе, «0 новых» не пишем
    assert "Обновлено" not in page("astana") and "pay-stats" not in page("astana")
    assert "Жаңартылды: 27.10, 17:17. 24 сағатта 2 жаңа вакансия, 3 күнде 5.</p>" in page("kk")
    assert "Жаңартылды: 27.10, 17:17. 24 сағатта 1 жаңа вакансия.</p>" in page("kk", "karaganda")
    assert "Жаңартылды: 27.10, 17:17. 3 күнде 1 жаңа вакансия.</p>" in page("kk", "shymkent")
    assert "Жаңартылды" not in page("kk", "astana")


def test_fresh_line_counts_by_kazakhstan_time_and_declines_the_words():
    """Сутки и три дня считаются от времени сборки; дата и время в строке — по времени Казахстана."""
    late = datetime(2026, 10, 27, 20, 30, tzinfo=timezone.utc)  # в Казахстане уже 28 октября, 01:30
    items = [post(i, "Кафе ищет официанта", hours_ago=h) for i, h in enumerate((0, 15, 32, 60, 63, 64, 200), 1)]
    assert site.fresh_counts(items, late) == (2, 5)  # к late постам 8,5–23,5 часа и до 71,5; следующему уже 72,5
    assert site.fresh_line(2, 5, late, "ru") == "Обновлено 28.10 в 01:30: 2 новые вакансии за сутки, 5 за три дня."
    assert site.fresh_line(21, 105, late, "ru") == "Обновлено 28.10 в 01:30: 21 новая вакансия за сутки, 105 за три дня."
    assert site.fresh_line(0, 12, late, "ru") == "Обновлено 28.10 в 01:30: 12 новых вакансий за три дня."
    assert site.fresh_line(0, 12, late, "kk") == "Жаңартылды: 28.10, 01:30. 3 күнде 12 жаңа вакансия."
    assert site.fresh_line(0, 0, late, "ru") is None and site.fresh_line(0, 0, late, "kk") is None


def test_shift_pages_tell_the_usual_pay_per_shift(tmp_path):
    """«Подработка и смены»: от пяти вакансий с оплатой за смену — обычная оплата за смену, до сотен тенге."""
    per_shift = [paid(i, amount, "day") for i, amount in enumerate((10_000, 11_540, 12_000, 13_560, 15_000, 18_000), 1)]
    monthly = [paid(10 + i, amount, perks=["Ежедневная оплата"])
               for i, amount in enumerate((200_000, 220_000, 250_000, 280_000, 300_000))]
    few = [paid(20 + i, 9_000, "day", "astana") for i in range(4)]
    many = [paid(30 + i, 8_000 + 100 * i, "day", "shymkent") for i in range(11)]
    out = build_site(tmp_path, per_shift + monthly + few + many)
    page = lambda *path: out.joinpath(*path, "index.html").read_text("utf-8")  # noqa: E731
    m = site.money
    almaty = page("almaty", shifts.SLUG)
    assert (f'<p class="pay-stats">Оплата за смену по 6 вакансиям: в среднем {m(13600)} ₸, обычно от {m(11500)} '
            f"до {m(15000)} ₸.</p>") in almaty
    # Строка о месячной зарплате остаётся: в разделе есть и вакансии с месячной оплатой (платят каждый день)
    monthly_line = f"Зарплата по 5 вакансиям с месячной оплатой: в среднем {m(250000)} ₸, обычно от {m(220000)} до {m(280000)} ₸ в месяц."
    assert almaty.index("<h1>") < almaty.index("Обновлено") < almaty.index("Оплата за смену по") < almaty.index(monthly_line)
    assert (f"Ауысым үшін төлем, 6 вакансия бойынша: орташа {m(13600)} ₸, әдетте {m(11500)} – {m(15000)} ₸."
            in page("kk", "almaty", shifts.SLUG))
    # Меньше пяти вакансий с оплатой за смену: «обычной» оплаты не называем
    assert "Оплата за смену по" not in page("astana", shifts.SLUG)
    # Только в разделе смен: на странице города этой строки нет
    assert "Оплата за смену по" not in page("almaty") and "Оплата за смену по" not in page()
    assert f"Оплата за смену по 21 вакансии: в среднем {m(9000)} ₸, обычно от {m(8500)} до {m(10000)} ₸." in page(shifts.SLUG)
    assert site.pay_stats(per_shift + monthly) == (5, 250000, 220000, 280000)
    assert site.pay_stats(per_shift[:4], "day") is None


def test_vacancy_page_compares_the_salary_with_the_median(tmp_path):
    """Под фактами вакансии: медиана месячной зарплаты той же профессии в городе, по скольким вакансиям она
    посчитана и где рядом с ней эта вакансия. Профессии не хватает на медиану — сравниваем со сферой."""
    waiters = [paid(i, amount) for i, amount in enumerate((200_000, 220_000, 250_000, 270_000, 280_000, 300_000, 350_000), 1)]
    cooks = [replace(post(20 + i, "Требуется повар"), salary_min=amount, salary_max=amount, salary_period="month")
             for i, amount in enumerate((240_000, 400_000))]
    others = [paid(30, 12_000, "day"), post(31, "Кафе ищет официанта"), paid(32, 250_000, city=None),
              *(paid(40 + i, 250_000, city="astana") for i in range(4)),
              *(replace(paid(50 + i, 300_000), title="Сотрудник", category="other") for i in range(5))]
    out = build_site(tmp_path, waiters + cooks + others)
    page = lambda *path: out.joinpath(*path, "index.html").read_text("utf-8")  # noqa: E731
    m = site.money
    line = ('<p class="pay-stats"><a href="/almaty/oficiant/">Официант в Алматы</a>: медианная зарплата по 7 вакансиям — '
            f"{m(270000)} ₸ в месяц, в этой вакансии %s.</p>")
    assert line % "ниже медианы" in page("v", "chan-2")  # 220 000 при медиане 270 000
    assert line % "на уровне медианы" in page("v", "chan-3") and line % "на уровне медианы" in page("v", "chan-5")
    assert line % "выше медианы" in page("v", "chan-6")  # 300 000: больше чем на 10% выше
    low = page("v", "chan-1")
    assert low.index("</dl>") < low.index("медианная зарплата") < low.index('class="apply"')
    assert ('<a href="/kk/almaty/oficiant/">Даяшы, Алматы</a>: 7 вакансия бойынша медианалық жалақы — '
            f"айына {m(270000)} ₸, бұл вакансияда медианадан жоғары.</p>") in page("kk", "v", "chan-7")
    assert "бұл вакансияда медиана деңгейінде." in page("kk", "v", "chan-4")
    assert "бұл вакансияда медианадан төмен." in page("kk", "v", "chan-1")
    # Поваров с месячной зарплатой двое: медиана по сфере в городе, ссылка на страницу сферы
    assert ('<a href="/almaty/horeca/">Кафе и рестораны в Алматы</a>: медианная зарплата по 9 вакансиям — '
            f"{m(270000)} ₸ в месяц, в этой вакансии ниже медианы.</p>") in page("v", "chan-20")
    assert "Кафе мен мейрамханалар, Алматы</a>: 9 вакансия бойынша" in page("kk", "v", "chan-21")
    # Не сравниваем: оплата за смену, зарплаты нет, города нет, в городе меньше пяти вакансий с зарплатой, сфера «Другое»
    for vacancy_id in ("chan-30", "chan-31", "chan-32", "chan-40", "chan-50"):
        assert "медиан" not in page("v", vacancy_id) and "медиан" not in page("kk", "v", vacancy_id)


def test_pay_level_counts_ten_percent_as_the_same():
    """Отличие от медианы до 10% в любую сторону — «на уровне»; зарплата вилкой сравнивается по середине."""
    assert site.pay_level(297_000, 270_000) == site.pay_level(243_000, 270_000) == "на уровне медианы"
    assert (site.pay_level(297_001, 270_000), site.pay_level(242_999, 270_000)) == ("выше медианы", "ниже медианы")
    waiter = paid(1, 250_000)
    assert site.pay_of(replace(waiter, salary_min=200_000, salary_max=400_000)) == 300_000
    assert site.pay_of(replace(waiter, salary_min=None)) == 250_000
    assert site.pay_of(replace(waiter, salary_period="day")) is None and site.pay_of(waiter, "day") is None
    assert site.pay_of(post(2, "Кафе ищет официанта")) is None

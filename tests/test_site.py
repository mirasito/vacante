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
    assert count == 4  # главная, город, город+сфера, вакансия
    page = (out / "v" / "chan-5" / "index.html").read_text("utf-8")
    assert "Официант" in page and "14 000 – 18 000 ₸/день" in page
    assert 'href="https://t.me/chan/5"' in page
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
    assert 'data-perks="Питание|Без опыта"' in home
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
    assert "Разместите вакансию бесплатно" in city
    assert site.more_links("astana")[1] == ("OLX", "https://www.olx.kz/rabota/astana/")
    assert site.more_links(None)[0] == ("hh.kz", "https://hh.kz/search/vacancy?area=40")

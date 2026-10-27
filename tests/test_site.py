from datetime import datetime, timezone

from vacante.models import RawPost
from vacante.parse import parse_post
from vacante.site.build import build
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

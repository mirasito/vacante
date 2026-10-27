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

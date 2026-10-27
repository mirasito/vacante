from datetime import datetime, timezone
from pathlib import Path

from vacante.sources.telegram import parse_channel_page

FIXTURE = Path(__file__).parent / "fixtures" / "telegram_channel.html"


def test_parses_text_posts_and_skips_photo_only():
    posts = parse_channel_page(FIXTURE.read_text("utf-8"), "almatyrabota1", "almaty")
    assert [p.post_id for p in posts] == [21258, 21259]
    first = posts[0]
    assert first.url == "https://t.me/almatyrabota1/21258"
    assert first.posted_at == datetime(2026, 10, 26, 10, 40, tzinfo=timezone.utc)
    assert first.default_city == "almaty"
    assert first.text.splitlines()[0] == "Ресторан Ramen77 ищет официанта"
    assert "Питание и развозка" in first.text.splitlines()

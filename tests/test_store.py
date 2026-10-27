from datetime import datetime, timezone

from vacante.models import RawPost
from vacante.parse import parse_post
from vacante.store import expire, load_vacancies, merge, save_vacancies

TEXT = "Требуется бариста в кофейню «Зерно», 2/2, 12 000 тг за смену, обучение"


def make(channel: str, post_id: int, text: str = TEXT, day: int = 27):
    raw = RawPost("telegram", channel, post_id, f"https://t.me/{channel}/{post_id}", text,
                  datetime(2026, 10, day, tzinfo=timezone.utc), "almaty")
    return parse_post(raw)


def test_merge_glues_reposts_from_other_channels():
    first = make("chan_a", 1, day=25)
    repost = make("chan_b", 7, TEXT + "\n\nПодписывайтесь на канал", day=27)
    merged = merge([first], [repost])
    assert len(merged) == 1
    assert merged[0].also_seen_in == ["https://t.me/chan_b/7"]
    assert merged[0].posted_at.startswith("2026-10-27")


def test_merge_glues_near_duplicates():
    a = make("chan_a", 1)
    b = make("chan_b", 2, TEXT + " Звоните!")
    assert len(merge([a], [b])) == 1


def test_merge_keeps_different_vacancies_and_ignores_known_ids():
    a = make("chan_a", 1)
    other = make("chan_a", 2, "Требуется повар в столовую, 300 000 тг, 6/1")
    merged = merge([a], [other, make("chan_a", 1)])
    assert [v.id for v in merged] == ["chan_a-1", "chan_a-2"]


def test_expire_and_roundtrip(tmp_path):
    old, fresh = make("chan_a", 1, day=1), make("chan_a", 2, "Нужен грузчик на склад, 250 000 тг", day=26)
    kept = expire([old, fresh], max_age_days=14, now=datetime(2026, 10, 27, tzinfo=timezone.utc))
    assert [v.id for v in kept] == ["chan_a-2"]
    save_vacancies(tmp_path, kept)
    assert load_vacancies(tmp_path) == kept

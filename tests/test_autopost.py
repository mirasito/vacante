import json
from datetime import datetime, timedelta, timezone

from vacante import autopost
from vacante.models import RawPost
from vacante.parse import parse_post
from vacante.store import save_vacancies

NOON = datetime(2026, 10, 27, 7, tzinfo=timezone.utc)  # 12:00 в Казахстане


def make(post_id: int, text: str, city: str = "almaty", hour: int = 5):
    raw = RawPost("telegram", "chan", post_id, f"https://t.me/chan/{post_id}", text,
                  datetime(2026, 10, 27, hour, tzinfo=timezone.utc), city)
    return parse_post(raw)


def test_due_only_in_daytime_and_after_gap():
    assert autopost.is_due(None, NOON)
    assert not autopost.is_due(None, datetime(2026, 10, 27, 17, tzinfo=timezone.utc))  # 22:00 местного
    assert not autopost.is_due("2026-10-27T06:55:00+00:00", NOON)
    assert autopost.is_due("2026-10-27T06:45:00+00:00", NOON)
    assert autopost.is_due("2026-10-27T06:49:00+00:00", NOON)  # прошлый пост серии опоздал на 4 минуты


def test_pick_prefers_complete_fresh_unposted_and_varies_titles():
    bare = make(1, "Требуется грузчик на склад")
    full = make(2, "Кафе «Зерно» ищет бариста, 2/2, 12 000 тг за смену, питание")
    other_city = make(3, "Кафе «Луна» ищет официанта, 300 000 тг", city="astana")
    old = make(4, "Ресторан «Сад» ищет повара, 400 000 тг", hour=5)
    old.posted_at = "2026-10-20T05:00:00+00:00"
    vacancies = [bare, full, other_city, old]
    assert autopost.pick(vacancies, "almaty", {}, NOON) is full
    assert autopost.pick(vacancies, "almaty", {"ids": [full.id]}, NOON) is bare
    assert autopost.pick(vacancies, "almaty", {"titles": ["Бариста"]}, NOON) is bare


def test_caption_has_the_rest_escaped():
    v = make(5, "Кафе «Зерно & Ко» ищет бариста, 2/2, 12 000 тг за смену, питание")
    assert autopost.format_caption(v) == (
        "В Зерно &amp; Ко требуется <b>бариста</b>\n🕒 График: 2/2\n✅ Питание\n\n#вакансии #общепит")
    many = make(9, "Требуются повар и официант")
    assert autopost.format_caption(many).startswith("Требуются <b>повар, официант</b>")


def test_post_is_picture_with_map_button():
    v = make(10, "Кафе «Зерно» ищет бариста, 12 000 тг за смену\n📍 Адрес: г. Алматы, ул. Жибек Жолы, 65А (Арбат)")
    post = autopost.make_post(v, "https://vacante.kz")
    assert post.photo.startswith(b"\x89PNG")
    assert post.buttons == [("👆 Подробнее", "https://vacante.kz/v/chan-10/"),
                            ("📍 Открыть в 2ГИС", "https://2gis.kz/almaty/search/"
                             "%D1%83%D0%BB.%20%D0%96%D0%B8%D0%B1%D0%B5%D0%BA%20%D0%96%D0%BE%D0%BB%D1%8B%2C%2065%D0%90")]
    no_address = autopost.make_post(make(11, "Кафе «Зерно» ищет бариста"), "https://vacante.kz")
    assert [text for text, _ in no_address.buttons] == ["👆 Подробнее"]


def test_run_posts_once_per_channel_and_remembers(tmp_path):
    save_vacancies(tmp_path, [make(6, "Кафе «Зерно» ищет бариста, 12 000 тг за смену"),
                              make(7, "Ресторан «Луна» ищет повара, 400 000 тг", city="astana")])
    sent = []
    stats = autopost.run(tmp_path, "https://vacante.kz/", lambda chat, post: sent.append((chat, post.buttons[0][1])), now=NOON)
    assert stats == {"posted": 2, "failed": 0}
    assert sorted(sent) == [("@vacantealmaty", "https://vacante.kz/v/chan-6/"),
                            ("@vacanteastana", "https://vacante.kz/v/chan-7/")]
    # Через час слот ещё не подошёл, через три часа нечего публиковать: всё уже вышло
    assert autopost.run(tmp_path, "https://vacante.kz", lambda *a: sent.append(a),
                        now=datetime(2026, 10, 27, 8, tzinfo=timezone.utc))["posted"] == 0
    assert autopost.load_posted(tmp_path)["almaty"]["ids"] == ["chan-6"]


def test_failed_send_is_not_remembered(tmp_path):
    save_vacancies(tmp_path, [make(8, "Кафе «Зерно» ищет бариста, 12 000 тг за смену")])

    def fail(chat, post):
        raise RuntimeError("Telegram 403: bot is not a member of the channel chat")

    assert autopost.run(tmp_path, "https://vacante.kz", fail, now=NOON) == {"posted": 0, "failed": 1}
    assert autopost.load_posted(tmp_path)["almaty"]["ids"] == []


def test_same_employer_is_not_posted_again_for_three_days(tmp_path):
    # Одну вакансию работодатель разместил в нескольких каналах разными словами
    first = make(20, "Рестопарк «DINO FEST» ищет бармена, 300 000 тг")
    repost = make(21, "Ресторан «DINO FEST» ищет официантов, 250 000 тг, питание")
    other = make(22, "Кафе «Луна» ищет повара, 200 000 тг")
    save_vacancies(tmp_path, [first, repost, other])
    sent = []
    for minutes in (0, 15, 30):
        autopost.run(tmp_path, "https://vacante.kz", lambda chat, post: sent.append(post.buttons[0][1]),
                     now=NOON + timedelta(minutes=minutes))
    assert sent == ["https://vacante.kz/v/chan-21/", "https://vacante.kz/v/chan-22/"]
    state = autopost.load_posted(tmp_path)["almaty"]
    assert state["employers"] == {"almaty:dino fest": NOON.isoformat(),
                                  "almaty:луна": (NOON + timedelta(minutes=15)).isoformat()}
    later = NOON + autopost.EMPLOYER_GAP + timedelta(minutes=1)
    assert autopost.pick([first, repost], "almaty", state, NOON + timedelta(hours=1)) is None
    assert autopost.pick([first, repost], "almaty", state, later) is None  # свежесть 48 часов уже вышла
    first.posted_at = later.isoformat()
    assert autopost.pick([first, repost], "almaty", state, later) is first


def test_employers_posted_before_the_fix_are_remembered(tmp_path):
    old = make(23, "Компания «WeFind» ищет грузчика на склад Kaspi, 300 000 тг")
    again = make(24, "Компания «WeFind» ищет грузчика на склад, 350 000 тг, развозка")
    save_vacancies(tmp_path, [old, again])
    (tmp_path / "posted.json").write_text(json.dumps(
        {"almaty": {"ids": [old.id], "titles": [old.title], "last_at": "2026-10-27T06:00:00+00:00"}}), "utf-8")
    sent = []
    autopost.run(tmp_path, "https://vacante.kz", lambda chat, post: sent.append(chat), now=NOON)
    assert sent == []
    assert autopost.load_posted(tmp_path)["almaty"]["employers"] == {"almaty:wefind": "2026-10-27T06:00:00+00:00"}


def test_earlier_approved_goes_first_among_equal():
    a = make(25, "Цветочный «Lumi» ищет флориста, 300 000 тг", hour=2)
    b = make(26, "Кафе «Зерно» ищет бариста, 300 000 тг", hour=6)
    approved = {a.id: "2026-10-27T03:00:00+00:00", b.id: "2026-10-27T06:30:00+00:00"}
    assert autopost.pick([a, b], "almaty", {}, NOON) is b  # без агента самая свежая
    assert autopost.pick([a, b], "almaty", {}, NOON, approved_at=approved) is a

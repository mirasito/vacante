from datetime import datetime, timezone

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
    assert not autopost.is_due("2026-10-27T05:30:00+00:00", NOON)
    assert autopost.is_due("2026-10-27T04:00:00+00:00", NOON)
    assert autopost.is_due("2026-10-27T04:05:00+00:00", NOON)  # прошлый запуск опоздал на 5 минут


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


def test_post_has_main_fields_escaped():
    v = make(5, "Кафе «Зерно & Ко» ищет бариста, 2/2, 12 000 тг за смену, питание\n" + "Обязанности: " + "варить кофе " * 40)
    assert autopost.format_post(v) == (
        "<b>Бариста</b>\n💰 от 12\u00a0000 ₸/день\n🕒 2/2\n🏢 Зерно &amp; Ко\n✅ Питание\n\n#вакансии #общепит")


def test_run_posts_once_per_channel_and_remembers(tmp_path):
    save_vacancies(tmp_path, [make(6, "Кафе «Зерно» ищет бариста, 12 000 тг за смену"),
                              make(7, "Ресторан «Луна» ищет повара, 400 000 тг", city="astana")])
    sent = []
    stats = autopost.run(tmp_path, "https://vacante.kz/", lambda chat, text, url: sent.append((chat, url)), now=NOON)
    assert stats == {"posted": 2, "failed": 0}
    assert sorted(sent) == [("@vacantealmaty", "https://vacante.kz/v/chan-6/"),
                            ("@vacanteastana", "https://vacante.kz/v/chan-7/")]
    # Через час слот ещё не подошёл, через три часа нечего публиковать: всё уже вышло
    assert autopost.run(tmp_path, "https://vacante.kz", lambda *a: sent.append(a),
                        now=datetime(2026, 10, 27, 8, tzinfo=timezone.utc))["posted"] == 0
    assert autopost.load_posted(tmp_path)["almaty"]["ids"] == ["chan-6"]


def test_failed_send_is_not_remembered(tmp_path):
    save_vacancies(tmp_path, [make(8, "Кафе «Зерно» ищет бариста, 12 000 тг за смену")])

    def fail(chat, text, url):
        raise RuntimeError("Telegram 403: bot is not a member of the channel chat")

    assert autopost.run(tmp_path, "https://vacante.kz", fail, now=NOON) == {"posted": 0, "failed": 1}
    assert autopost.load_posted(tmp_path)["almaty"]["ids"] == []

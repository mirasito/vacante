import json
from dataclasses import replace
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


def local(hour: int, minute: int = 0, day: int = 27) -> datetime:
    return datetime(2026, 10, day, hour, minute, tzinfo=autopost.LOCAL).astimezone(timezone.utc)


def test_slots_are_a_few_hours_of_the_day():
    assert autopost.slot(NOON) == "2026-10-27T12"
    assert autopost.slot(local(13, 55)) == "2026-10-27T12"  # слот длится до начала следующего
    assert autopost.slot(local(14)) == "2026-10-27T14"
    assert autopost.slot(local(21, 59)) == "2026-10-27T20"
    assert autopost.slot(local(8, 30)) is None  # до первого слота: утром выходит только подборка
    assert autopost.slot(local(22)) is None and autopost.slot(local(3)) is None
    assert 5 <= len(autopost.SLOTS) <= 8


def test_pick_prefers_complete_fresh_unposted_and_varies_titles():
    bare = make(1, "Требуется грузчик на склад, 200 000 тг", city="astana")
    full = make(2, "Кафе «Зерно» ищет бариста, 2/2, 12 000 тг за смену, питание", city="astana")
    other_city = make(3, "Кафе «Луна» ищет официанта, 300 000 тг", city="almaty")
    old = make(4, "Ресторан «Сад» ищет повара, 400 000 тг", city="astana", hour=5)
    old.posted_at = "2026-10-20T05:00:00+00:00"
    vacancies = [bare, full, other_city, old]
    assert autopost.pick(vacancies, "astana", {}, NOON) is full
    assert autopost.pick(vacancies, "astana", {"ids": [full.id]}, NOON) is bare
    assert autopost.pick(vacancies, "astana", {"titles": ["Бариста"]}, NOON) is bare


def test_almaty_channel_takes_only_horeca_from_the_queue():
    loader = make(30, "Требуется грузчик на склад, 400 000 тг, питание, развозка, 5/2")
    waiter = make(31, "Кафе «Луна» ищет официанта")
    assert loader.category == "warehouse" and waiter.category == "horeca"
    assert autopost.pick([loader, waiter], "almaty", {}, NOON) is waiter
    assert autopost.pick([loader], "almaty", {}, NOON) is None
    # Агенту на проверку для канала Алматы тоже идёт только общепит
    assert autopost.review_queue([loader, waiter], {}, {}, NOON) == [waiter]
    # В канале другого города сферы нет: идёт всё
    assert autopost.pick([replace(loader, city="astana")], "astana", {}, NOON) is not None
    # Вакансия от работодателя выходит в канал Алматы в любой сфере
    assert autopost.pick([replace(loader, source="bot")], "almaty", {}, NOON) is not None


def test_whatsapp_or_telegram_contact_goes_first():
    # Отклик со ссылкой на профиль возможен только в WhatsApp и Telegram: такие вакансии выше более полных
    full = make(32, "Кафе «Зерно» ищет бариста, 2/2, 12 000 тг за смену, питание, развозка")
    full.contact = ["phone"]
    plain = replace(make(33, "Кафе «Луна» ищет официанта"), contact=["whatsapp"])
    assert autopost.pick([full, plain], "almaty", {}, NOON) is plain


def test_pick_skips_vacancies_with_empty_card():
    empty = make(11, "Ерлер киім дүкеніне сатушы қыз керек. График: 5/2")
    assert not autopost.filled(empty)
    assert autopost.pick([empty], "almaty", {}, NOON) is None
    with_address = make(12, "Требуется продавец\n📍 Адрес: ул. Абая, 63", city="astana")
    assert autopost.pick([replace(empty, city="astana"), with_address], "astana", {}, NOON) is with_address


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
    # Первая кнопка открывает эту вакансию в мини-приложении, с меткой «свои каналы» для воронки
    assert post.buttons == [("✉️ Откликнуться", "https://t.me/vacantekz_bot?startapp=stg_a_almaty_chan-10"),
                            ("👆 Подробнее", "https://vacante.kz/v/chan-10/"),
                            ("📍 Открыть в 2ГИС", "https://2gis.kz/almaty/search/"
                             "%D1%83%D0%BB.%20%D0%96%D0%B8%D0%B1%D0%B5%D0%BA%20%D0%96%D0%BE%D0%BB%D1%8B%2C%2065%D0%90")]
    no_address = autopost.make_post(make(11, "Кафе «Зерно» ищет бариста"), "https://vacante.kz")
    assert [text for text, _ in no_address.buttons] == ["✉️ Откликнуться", "👆 Подробнее"]


def test_post_has_one_apply_button_even_when_original_post_has_contacts():
    # В посте есть WhatsApp и телефон, но под вакансией одна кнопка отклика: она ведёт в приложение, где человек
    # делает профиль и пишет работодателю в WhatsApp со ссылкой на него. Прямых кнопок мимо приложения нет
    v = replace(make(14, "Кафе «Зерно» ищет бариста"), contact=["whatsapp", "phone"])
    assert autopost.make_post(v, "https://vacante.kz").buttons == [
        ("✉️ Откликнуться", "https://t.me/vacantekz_bot?startapp=stg_a_almaty_chan-14"),
        ("👆 Подробнее", "https://vacante.kz/v/chan-14/")]


def test_post_without_apply_button_when_link_is_too_long():
    # Telegram принимает в ссылке запуска до 64 знаков: с длинным id вакансии остаётся карточка сайта
    v = replace(make(13, "Кафе «Зерно» ищет бариста"), id="a" * 60)
    assert [text for text, _ in autopost.make_post(v, "https://vacante.kz").buttons] == ["👆 Подробнее"]


def test_run_posts_once_per_channel_and_remembers(tmp_path):
    save_vacancies(tmp_path, [make(6, "Кафе «Зерно» ищет бариста, 12 000 тг за смену"),
                              make(7, "Ресторан «Луна» ищет повара, 400 000 тг", city="astana")])
    sent = []
    stats = autopost.run(tmp_path, "https://vacante.kz/", lambda chat, post: sent.append((chat, dict(post.buttons)["👆 Подробнее"])), now=NOON)
    assert stats == {"posted": 2, "failed": 0}
    assert sorted(sent) == [("@vacantealmaty", "https://vacante.kz/v/chan-6/"),
                            ("@vacanteastana", "https://vacante.kz/v/chan-7/")]
    # Через час идёт тот же слот; в следующем публиковать нечего: всё уже вышло
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
    for hours in (0, 2, 4):  # слоты 12:00, 14:00 и 16:00
        autopost.run(tmp_path, "https://vacante.kz", lambda chat, post: sent.append(dict(post.buttons)["👆 Подробнее"]),
                     now=NOON + timedelta(hours=hours))
    assert sent == ["https://vacante.kz/v/chan-21/", "https://vacante.kz/v/chan-22/"]
    state = autopost.load_posted(tmp_path)["almaty"]
    assert state["employers"] == {"almaty:dino fest": NOON.isoformat(),
                                  "almaty:луна": (NOON + timedelta(hours=2)).isoformat()}
    later = NOON + autopost.EMPLOYER_GAP + timedelta(minutes=1)
    assert autopost.pick([first, repost], "almaty", state, NOON + timedelta(hours=5)) is None
    assert autopost.pick([first, repost], "almaty", state, later) is None  # свежесть 48 часов уже вышла
    first.posted_at = later.isoformat()
    assert autopost.pick([first, repost], "almaty", state, later) is first


def test_employers_posted_before_the_fix_are_remembered(tmp_path):
    old = make(23, "Компания «WeFind» ищет грузчика на склад Kaspi, 300 000 тг", city="astana")
    again = make(24, "Компания «WeFind» ищет грузчика на склад, 350 000 тг, развозка", city="astana")
    save_vacancies(tmp_path, [old, again])
    (tmp_path / "posted.json").write_text(json.dumps(
        {"astana": {"ids": [old.id], "titles": [old.title], "last_at": "2026-10-27T06:00:00+00:00"}}), "utf-8")
    sent = []
    autopost.run(tmp_path, "https://vacante.kz", lambda chat, post: sent.append(chat), now=NOON)
    assert sent == []
    assert autopost.load_posted(tmp_path)["astana"]["employers"] == {"astana:wefind": "2026-10-27T06:00:00+00:00"}


def test_earlier_approved_goes_first_among_equal():
    a = make(25, "Цветочный «Lumi» ищет флориста, 300 000 тг", city="astana", hour=2)
    b = make(26, "Кафе «Зерно» ищет бариста, 300 000 тг", city="astana", hour=6)
    approved = {a.id: "2026-10-27T03:00:00+00:00", b.id: "2026-10-27T06:30:00+00:00"}
    assert autopost.pick([a, b], "astana", {}, NOON) is b  # без агента самая свежая
    assert autopost.pick([a, b], "astana", {}, NOON, approved_at=approved) is a


def test_only_one_post_per_slot_and_a_few_per_day(tmp_path):
    cafes = ["Зерно", "Луна", "Сад", "Арбат", "Тары", "Нан", "Дала", "Бриз", "Жар", "Тау", "Лес", "Мёд"]
    jobs = ["бариста", "официанта", "повара", "бармена"]
    save_vacancies(tmp_path, [make(100 + i, f"Кафе «{name}» ищет {jobs[i % 4]}, {200 + i} 000 тг")
                              for i, name in enumerate(cafes)])
    sent = []
    # Автопостинг запускается каждые пять минут весь день
    for step in range(12 * 24):
        autopost.run(tmp_path, "https://vacante.kz", lambda chat, post: sent.append(chat),
                     now=local(0) + timedelta(minutes=5 * step), live={"almaty": "@vacantealmaty"})
    assert len(sent) == len(autopost.SLOTS) == 7


def test_morning_digest_once_a_day_and_its_vacancies_are_not_posted_again(tmp_path):
    cafes = ["Зерно", "Луна", "Сад", "Арбат", "Тары", "Нан"]
    jobs = ["бариста", "официанта", "повара"]
    save_vacancies(tmp_path, [make(200 + i, f"Кафе «{name} & Ко» ищет {jobs[i % 3]}, {200 + i} 000 тг")
                              for i, name in enumerate(cafes)]
                   + [make(210, "Требуется грузчик на склад, 400 000 тг")])
    texts, cards = [], []
    run = lambda now: autopost.run(tmp_path, "https://vacante.kz", lambda chat, post: cards.append(post.caption),  # noqa: E731
                                   now=now, live={"almaty": "@vacantealmaty"},
                                   send_promo=lambda chat, text, buttons: texts.append((text, buttons)))
    assert run(local(7, 55)).get("digest") is None and texts == []
    assert run(local(8))["digest"] == 1
    run(local(8, 5))
    digests = [(text, buttons) for text, buttons in texts if text.startswith("☀️")]
    assert len(digests) == 1
    text, buttons = digests[0]
    assert text.startswith("☀️ <b>Работа в общепите в Алматы: 27 октября</b>")
    assert text.count("•") == 6 and "грузчик" not in text.lower()  # канал Алматы — только общепит
    # Должность открывает эту вакансию в приложении с меткой подборки
    assert '<a href="https://t.me/vacantekz_bot?startapp=stgdg_v_almaty_chan-205">Повар</a> · Нан &amp; Ко · ' in text
    assert text.endswith("#вакансии #общепит")
    assert buttons == [("📱 Все вакансии · Алматы", "https://t.me/vacantekz_bot?startapp=stgdg_c_almaty")]
    # Все шесть вышли в подборке: в слот 9:00 публиковать нечего
    assert run(local(9))["posted"] == 0 and cards == []
    assert len(autopost.load_posted(tmp_path)["almaty"]["ids"]) == 6


def test_no_digest_when_vacancies_are_few(tmp_path):
    save_vacancies(tmp_path, [make(220, "Кафе «Зерно» ищет бариста, 250 000 тг"),
                              make(221, "Кафе «Луна» ищет повара, 300 000 тг")])
    texts = []
    stats = autopost.run(tmp_path, "https://vacante.kz", lambda chat, post: 1, now=local(8),
                         live={"almaty": "@vacantealmaty"}, send_promo=lambda chat, text, buttons: texts.append(text))
    assert "digest" not in stats and not any(t.startswith("☀️") for t in texts)
    # Обе выйдут обычными постами в свои слоты
    assert autopost.pick(autopost.load_vacancies(tmp_path), "almaty", autopost.load_posted(tmp_path)["almaty"], local(9))

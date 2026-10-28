import json
from datetime import datetime, timezone
from pathlib import Path

from vacante import digest
from vacante.digest import Subscription
from vacante.models import RawPost
from vacante.parse import CATEGORIES, CITIES, parse_post
from vacante.site.build import FILTER_PERKS
from vacante.store import save_vacancies

NOON = datetime(2026, 10, 27, 7, tzinfo=timezone.utc)  # 12:00 в Казахстане


def make(post_id: int, text: str, city: str = "almaty"):
    raw = RawPost("telegram", "chan", post_id, f"https://t.me/chan/{post_id}", text,
                  datetime(2026, 10, 27, 5, post_id % 60, tzinfo=timezone.utc), city)
    return parse_post(raw)


def sub(**kw) -> Subscription:
    return Subscription(**{"chat_id": 1, "city": "almaty", "categories": [], "perks": [], "min_pay": 0, **kw})


def test_subscription_from_row():
    row = {"chat_id": 42, "city": "", "categories": "horeca,retail", "perks": "Без опыта|salary", "min_pay": 300000}
    assert Subscription.from_row(row) == Subscription(42, None, ["horeca", "retail"], ["Без опыта", "salary"], 300000)


def test_matches_city_category_perks_and_pay():
    barista = make(1, "Кафе «Зерно» ищет бариста, 12 000 тг за смену, без опыта")  # 264 000 в месяц
    assert digest.matches(sub(), barista)
    assert not digest.matches(sub(city="astana"), barista)
    assert digest.matches(sub(city=None), barista)
    assert digest.matches(sub(categories=["horeca"]), barista)
    assert not digest.matches(sub(categories=["retail"]), barista)
    assert digest.matches(sub(perks=["Без опыта", "salary"]), barista)
    assert not digest.matches(sub(perks=["Жильё"]), barista)
    assert digest.matches(sub(min_pay=200000), barista)
    assert not digest.matches(sub(min_pay=300000), barista)
    assert not digest.matches(sub(perks=["salary"]), make(2, "Требуется грузчик на склад"))


def test_digest_lists_ten_and_points_to_site():
    hits = [make(i, f"Кафе «Луна» ищет официанта, {200 + i} 000 тг\n📍 Адрес: ул. Абая, {i}") for i in range(3, 15)]
    text = digest.format_digest(hits, "https://vacante.kz")
    assert text.startswith("🆕 Новые вакансии для вас: 12")
    assert text.count("<a href=") == 10 and "Остальные 2 на сайте" in text
    assert '<b><a href="https://vacante.kz/v/chan-3/">Официант</a></b> · Луна' in text
    assert "📍 Алматы, ул. Абая, 3" in text


def test_run_sends_only_new_matching_vacancies(tmp_path):
    save_vacancies(tmp_path, [make(10, "Кафе «Зерно» ищет бариста, 12 000 тг за смену")])
    sent = []
    subs = [sub(chat_id=1), sub(chat_id=2, city="astana"), sub(chat_id=3)]

    def send(chat_id, text, keyboard):
        if chat_id == 3:
            raise digest.Blocked(chat_id)
        sent.append((chat_id, text))

    # Первый запуск только запоминает, что уже есть
    assert digest.run(tmp_path, "https://vacante.kz", lambda: subs, send, now=NOON)["sent"] == 0
    assert json.loads((tmp_path / "digest.json").read_text())["seen"] == ["chan-10"]

    save_vacancies(tmp_path, [make(10, "Кафе «Зерно» ищет бариста, 12 000 тг за смену"),
                              make(11, "Ресторан «Сад» ищет повара, 400 000 тг")])
    stats = digest.run(tmp_path, "https://vacante.kz", lambda: subs, send, now=NOON)
    assert stats == {"new": 1, "sent": 1, "failed": 0, "blocked": [3]}
    assert [chat for chat, _ in sent] == [1] and "Повар" in sent[0][1] and "Бариста" not in sent[0][1]
    # Повторно то же самое не уходит
    assert digest.run(tmp_path, "https://vacante.kz", lambda: subs, send, now=NOON)["new"] == 0


def test_night_keeps_new_vacancies_for_morning(tmp_path):
    save_vacancies(tmp_path, [])
    digest.run(tmp_path, "https://vacante.kz", list, lambda *a: None, now=NOON)
    save_vacancies(tmp_path, [make(12, "Ресторан «Сад» ищет повара, 400 000 тг")])
    night = datetime(2026, 10, 27, 18, tzinfo=timezone.utc)  # 23:00 в Казахстане
    sent = []
    digest.run(tmp_path, "https://vacante.kz", lambda: [sub()], lambda *a: sent.append(a), now=night)
    assert sent == []
    morning = datetime(2026, 10, 28, 4, tzinfo=timezone.utc)  # 9:00
    digest.run(tmp_path, "https://vacante.kz", lambda: [sub()], lambda *a: sent.append(a), now=morning)
    assert len(sent) == 1


def test_bot_options_match_site():
    opts = json.loads((Path(__file__).parents[1] / "bot" / "src" / "options.json").read_text("utf-8"))
    assert opts["categories"] == [[slug, name] for slug, name in CATEGORIES.items()]
    assert opts["perks"] == FILTER_PERKS
    assert all(CITIES[slug][0] == name for slug, name in opts["cities"])

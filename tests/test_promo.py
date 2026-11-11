from datetime import date, datetime, timedelta, timezone

from vacante import autopost, promo
from vacante.models import RawPost
from vacante.parse import parse_post
from vacante.store import save_vacancies

LOCAL = timezone(timedelta(hours=5))


def at(hour: int, day: int = 12) -> datetime:
    return (datetime(2026, 11, 1, hour, tzinfo=LOCAL) + timedelta(days=day - 1)).astimezone(timezone.utc)


class Bot:
    def __init__(self, pin_fails: bool = False):
        self.sent, self.pins, self.next_id, self.pin_fails = [], [], 100, pin_fails

    def send(self, chat, text, buttons):
        self.next_id += 1
        self.sent.append((chat, text, buttons))
        return self.next_id

    def pin(self, chat, message_id, on):
        if self.pin_fails and on:
            raise RuntimeError("Telegram 400: not enough rights to manage pinned messages in the chat")
        self.pins.append((chat, message_id, on))


def test_texts_are_bilingual_with_city_link():
    assert promo.app_url("almaty") == "https://t.me/vacantekz_bot?startapp=almaty"
    for i in range(len(promo.DAILY)):
        text = promo.daily_text("almaty", date(2026, 11, 1) + timedelta(days=i), 120)
        assert "🇰🇿" in text and "{" not in text
    day = next(d for d in (date(2026, 11, 1) + timedelta(days=i) for i in range(4)) if d.toordinal() % 4 == 0)
    first = promo.daily_text("almaty", day, 120)  # первый текст: с числом вакансий
    assert "в Алматы" in first and "Алматыдағы" in first and "<b>120</b>" in first
    assert "<b>3</b>" not in promo.daily_text("almaty", date(2026, 11, 1), 3)  # мало: число не пишем
    assert "в Астане" in promo.pinned_text("astana") and "Астанадағы" in promo.pinned_text("astana")


def test_daily_post_once_a_day_after_hour_and_pinned_post_kept():
    bot, state, stats = Bot(), {}, {}
    run = lambda now: promo.run_channel("@vacantealmaty", "almaty", state, now, now.astimezone(LOCAL), 50,
                                        bot.send, bot.pin, stats)
    run(at(9))  # утром: только закреп
    assert len(bot.sent) == 1 and "📌" in bot.sent[0][1]
    assert bot.sent[0][2] == [("📱 Открыть приложение · Қосымшаны ашу", "https://t.me/vacantekz_bot?startapp=almaty")]
    assert bot.pins == [("@vacantealmaty", 101, True)]
    run(at(10))
    assert len(bot.sent) == 1
    run(at(13))
    run(at(14))
    assert len(bot.sent) == 2 and "📌" not in bot.sent[1][1]
    run(at(13, day=13))
    assert len(bot.sent) == 3
    # Через три недели закреп публикуем заново, старый открепляем (автоудаление через 30 дней)
    run(at(9, day=12 + 21))
    assert bot.pins[-2:] == [("@vacantealmaty", 104, True), ("@vacantealmaty", 101, False)]
    assert state["app_pin"]["message_id"] == 104 and state["app_pin"]["pinned"]


def test_pin_without_rights_is_retried_later_not_reposted():
    bot, state, stats = Bot(pin_fails=True), {}, {}
    run = lambda now: promo.run_channel("@vacantekaraganda", "karaganda", state, now, now.astimezone(LOCAL), 0,
                                        bot.send, bot.pin, stats)
    run(at(9))
    run(at(10))
    assert len(bot.sent) == 1 and not state["app_pin"]["pinned"]
    bot.pin_fails = False
    run(at(16))  # прошло 6 часов: пробуем снова закрепить тот же пост (и выходит ежедневный)
    assert bot.pins == [("@vacantekaraganda", 101, True)] and state["app_pin"]["pinned"]
    assert len(bot.sent) == 2


def test_autopost_run_sends_promo_only_in_daytime(tmp_path):
    raw = RawPost("telegram", "chan", 1, "https://t.me/chan/1", "Кафе «Зерно» ищет бариста, 12 000 тг за смену",
                  at(8), "almaty")
    save_vacancies(tmp_path, [parse_post(raw)])
    bot = Bot()
    live = {"almaty": "@vacantealmaty"}
    autopost.run(tmp_path, "https://vacante.kz", lambda c, p: 1, now=at(3), pin=bot.pin, live=live, send_promo=bot.send)
    assert bot.sent == []
    stats = autopost.run(tmp_path, "https://vacante.kz", lambda c, p: 1, now=at(13), pin=bot.pin, live=live,
                         send_promo=bot.send)
    assert stats["app"] == 1 and stats["app_pinned"] == 1 and len(bot.sent) == 2
    state = autopost.load_posted(tmp_path)["almaty"]
    assert state["app_on"] == "2026-11-12" and state["app_pin"]["message_id"] == 102

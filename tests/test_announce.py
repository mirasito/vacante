import pytest

from vacante import announce

LIVE = {"almaty": "@vacantealmaty", "astana": "@vacanteastana"}


class Bot:
    def __init__(self, fail: str | None = None):
        self.sent, self.fail = [], fail

    def send(self, chat, text, buttons):
        if chat == self.fail:
            raise RuntimeError("Telegram 403: bot is not a member of the channel chat")
        self.sent.append((chat, text, buttons))
        return len(self.sent)


def test_announcement_goes_to_every_live_channel_with_city_link():
    bot, posted = Bot(), {}
    assert announce.run("apply-button", posted, LIVE, bot.send) == {"sent": 2, "skipped": 0, "failed": 0}
    chat, text, buttons = bot.sent[0]
    assert chat == "@vacantealmaty"
    assert "Откликнуться" in text and "в Алматы" in text and "Алматыдағы" in text
    # Кнопка ведёт в ленту города с меткой источника для воронки
    assert buttons == [("📱 Открыть вакансии · Бос орындарды ашу", "https://t.me/vacantekz_bot?startapp=slive_c_almaty")]
    assert bot.sent[1][2][0][1].endswith("startapp=slive_c_astana")
    assert posted == {"almaty": {"announced": ["apply-button"]}, "astana": {"announced": ["apply-button"]}}


def test_announcement_is_not_repeated_and_failed_channel_gets_it_next_time():
    posted = {"almaty": {"last_at": "2026-11-15T10:00:00+00:00"}}
    bot = Bot(fail="@vacanteastana")
    assert announce.run("apply-button", posted, LIVE, bot.send) == {"sent": 1, "skipped": 0, "failed": 1}
    assert posted["almaty"] == {"last_at": "2026-11-15T10:00:00+00:00", "announced": ["apply-button"]}
    assert posted["astana"] == {"announced": []}
    again = Bot()
    assert announce.run("apply-button", posted, LIVE, again.send) == {"sent": 1, "skipped": 1, "failed": 0}
    assert [chat for chat, _, _ in again.sent] == ["@vacanteastana"]


def test_unknown_announcement_is_an_error_and_sends_nothing():
    bot = Bot()
    with pytest.raises(ValueError, match="нет объявления"):
        announce.run("typo", {}, LIVE, bot.send)
    assert bot.sent == []


def test_text_fits_telegram_limit_for_every_city():
    from vacante import channels

    for city in channels.ALL:
        assert len(announce.text_for("apply-button", city)) < 4096


def test_employer_post_leads_to_bot_questionnaire_and_tagged_landing():
    bot = Bot()
    assert announce.run("employers-paste", {}, LIVE, bot.send)["sent"] == 2
    _, text, buttons = bot.sent[0]
    assert "вставьте в бот" in text and "hh.kz" in text and "990 ₸" in text and "3 990 ₸" in text
    assert "в Алматы" in text and "Алматыдағы" in text
    assert buttons[0] == ("⚡ Разместить вакансию · Орналастыру", "https://t.me/vacantekz_bot?start=post_ch")
    assert buttons[1][1] == ("https://vacante.kz/rabotodatelyam/?utm_source=telegram&utm_medium=channel"
                             "&utm_campaign=employers_paste&utm_content=almaty")
    assert bot.sent[1][2][1][1].endswith("utm_content=astana")


def test_every_announcement_fits_telegram_limit_for_every_city():
    from vacante import channels

    for name in announce.ANNOUNCEMENTS:
        for city in channels.ALL:
            assert "{" not in announce.text_for(name, city)
            assert len(announce.text_for(name, city)) < 4096
            assert all(url.startswith("https://") for _, url in announce.buttons_for(name, city))

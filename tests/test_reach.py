from datetime import datetime, timedelta, timezone

from vacante import autopost, reach
from vacante.models import RawPost
from vacante.parse import parse_post
from vacante.store import save_vacancies

LOCAL = timezone(timedelta(hours=5))
NOW = datetime(2026, 11, 16, 9, 5, tzinfo=LOCAL).astimezone(timezone.utc)

PAGE = """
<div class="tgme_widget_message" data-post="vacantealmaty/501">
  <div class="tgme_widget_message_text">Бариста</div>
  <span class="tgme_widget_message_views">1.2K</span>
  <a class="tgme_widget_message_date" href="#"><time datetime="2026-11-15T04:00:00+00:00"></time></a>
</div>
<div class="tgme_widget_message" data-post="vacantealmaty/502">
  <span class="tgme_widget_message_views">87</span>
  <a class="tgme_widget_message_date" href="#"><time datetime="2026-11-15T09:00:00+05:00"></time></a>
</div>
<div class="tgme_widget_message" data-post="vacantealmaty/503">
  <a class="tgme_widget_message_date" href="#"><time datetime="2026-11-15T10:00:00+00:00"></time></a>
</div>
"""


def test_views_are_read_from_channel_preview():
    assert reach.parse_views(PAGE) == [
        (501, datetime(2026, 11, 15, 4, tzinfo=timezone.utc), 1200),
        (502, datetime(2026, 11, 15, 4, tzinfo=timezone.utc), 87),
    ]  # пост без счётчика просмотров пропущен


def test_measure_counts_posts_between_one_and_two_days_old():
    views = [(NOW - timedelta(hours=30), 40), (NOW - timedelta(hours=26), 20), (NOW - timedelta(hours=47), 90),
             (NOW - timedelta(hours=2), 5), (NOW - timedelta(hours=60), 500)]
    assert reach.measure(views, 2000, NOW) == {"subscribers": 2000, "posts": 3, "views": 40, "share": 2.0}
    # Постов нужного возраста нет или число подписчиков неизвестно: доли нет
    assert reach.measure([], 2000, NOW) == {"subscribers": 2000, "posts": 0, "views": None, "share": None}
    assert reach.measure(views, None, NOW)["share"] is None


def test_record_once_a_day_and_retries_hourly_on_failure():
    state, calls = {}, []

    def meter(chat):
        calls.append(chat)
        return None if len(calls) == 1 else {"subscribers": 1948, "views": [(NOW - timedelta(hours=30), 39)]}

    reach.record(state, "@vacantealmaty", NOW - timedelta(hours=1), meter)  # 8:05: рано
    assert calls == []
    reach.record(state, "@vacantealmaty", NOW, meter)  # не ответили
    reach.record(state, "@vacantealmaty", NOW + timedelta(minutes=5), meter)  # в тот же час не повторяем
    assert len(calls) == 1 and "reach" not in state
    reach.record(state, "@vacantealmaty", NOW + timedelta(hours=1), meter)
    reach.record(state, "@vacantealmaty", NOW + timedelta(hours=2), meter)  # сегодня уже записано
    assert len(calls) == 2
    assert state["reach"] == [{"on": "2026-11-16", "subscribers": 1948, "posts": 1, "views": 39, "share": 2.0}]
    reach.record(state, "@vacantealmaty", NOW + timedelta(days=1), meter)
    assert [r["on"] for r in state["reach"]] == ["2026-11-16", "2026-11-17"]


def test_autopost_run_records_reach(tmp_path):
    raw = RawPost("telegram", "chan", 1, "https://t.me/chan/1", "Кафе «Зерно» ищет бариста, 12 000 тг за смену",
                  NOW - timedelta(hours=3), "almaty")
    save_vacancies(tmp_path, [parse_post(raw)])
    autopost.run(tmp_path, "https://vacante.kz", lambda c, p: 1, now=NOW, live={"almaty": "@vacantealmaty"},
                 meter=lambda chat: {"subscribers": 1948, "views": []})
    assert autopost.load_posted(tmp_path)["almaty"]["reach"][0]["subscribers"] == 1948

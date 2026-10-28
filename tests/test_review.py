import json
from datetime import datetime, timezone

from vacante import autopost, review
from vacante.models import RawPost
from vacante.parse import parse_post
from vacante.store import save_vacancies

NOON = datetime(2026, 10, 27, 7, tzinfo=timezone.utc)  # 12:00 в Казахстане


def make(post_id: int, text: str, city: str = "almaty", hour: int = 5):
    raw = RawPost("telegram", "chan", post_id, f"https://t.me/chan/{post_id}", text,
                  datetime(2026, 10, 27, hour, tzinfo=timezone.utc), city)
    return parse_post(raw)


def test_queue_takes_best_unreviewed_unposted_per_city():
    full = make(1, "Кафе «Зерно» ищет бариста, 2/2, 12 000 тг за смену, питание")
    bare = make(2, "Требуется грузчик на склад")
    done = make(3, "Ресторан «Сад» ищет повара, 400 000 тг")
    posted = make(4, "Кафе «Луна» ищет официанта, 300 000 тг")
    astana = make(5, "Кафе «Луна» ищет официанта, 300 000 тг", city="astana")
    queue = autopost.review_queue([full, bare, done, posted, astana], {"almaty": {"ids": [posted.id]}},
                                  {done.id: {"verdict": "approve"}}, NOON)
    assert [v.id for v in queue] == [astana.id, full.id, bare.id]


def test_without_reviews_file_everything_goes_as_before(tmp_path):
    v = make(6, "Кафе «Зерно» ищет бариста, 12 000 тг за смену")
    assert review.load(tmp_path) is None
    assert autopost.checked_by_agent([v], None) == [v]


def test_apply_validates_and_channel_gets_only_approved_with_edits(tmp_path):
    good = make(7, "кафе зерно ищет БАРИСТА 12000 тг за смену")
    bad = make(8, "Требуется продавец, 200 000 тг")
    other = make(9, "Ресторан «Сад» ищет повара, 400 000 тг")
    vacancies = [good, bad, other]
    report = review.apply(tmp_path, [
        {"id": good.id, "verdict": "approve",
         "fields": {"title": "бариста", "employer": "Кафе «Зерно»", "salary_min": 12000, "salary_period": "day",
                    "perks": ["Питание"]}},
        {"id": bad.id, "verdict": "reject", "reason": "Работа в интернете без работодателя."},
        {"id": other.id, "verdict": "approve", "fields": {"salary_min": 10, "salary_period": "month"}},
        {"id": "chan-404", "verdict": "approve"},
    ], vacancies, now=NOON)
    assert report == [(good.id, "approved"), (bad.id, "rejected"),
                      (other.id, "error: salary_min: целое число от 40000 до 5000000"),
                      ("chan-404", "skipped: вакансии уже нет на сайте")]
    reviews = review.load(tmp_path)
    assert set(reviews) == {good.id, bad.id}
    allowed = autopost.checked_by_agent(vacancies, reviews)
    assert [v.id for v in allowed] == [good.id]
    v = allowed[0]
    assert (v.title, v.employer, v.salary_min, v.salary_max, v.salary_period, v.perks) == (
        "Бариста", "Кафе «Зерно»", 12000, None, "day", ["Питание"])


def test_apply_forgets_vacancies_gone_from_site(tmp_path):
    a, b = make(10, "Требуется грузчик"), make(11, "Требуется курьер")
    review.apply(tmp_path, [{"id": a.id, "verdict": "approve"}], [a, b], now=NOON)
    review.apply(tmp_path, [{"id": b.id, "verdict": "approve"}], [b], now=NOON)
    assert set(review.load(tmp_path)) == {b.id}


def test_run_posts_reviewed_and_writes_queue(tmp_path):
    ok = make(12, "Кафе «Зерно» ищет бариста, 12 000 тг за смену")
    waiting = make(13, "Кафе «Луна» ищет официанта, 300 000 тг, питание, 2/2")
    save_vacancies(tmp_path, [ok, waiting])
    review.apply(tmp_path, [{"id": ok.id, "verdict": "approve", "fields": {"title": "Бариста-кассир"}}], [ok, waiting],
                 now=NOON)
    sent = []
    autopost.run(tmp_path, "https://vacante.kz", lambda chat, post: sent.append((chat, post.caption)), now=NOON)
    assert len(sent) == 1 and "бариста-кассир" in sent[0][1]
    assert autopost.write_review_queue(tmp_path, now=NOON) == 1
    queue = json.loads((tmp_path / review.QUEUE).read_text("utf-8"))["vacancies"]
    assert [item["id"] for item in queue] == [waiting.id]

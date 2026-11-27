"""Страницы для поиска: срок объявления в разметке, снятые адреса для IndexNow."""

import inspect
import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import httpx

from vacante import collect, direct, searchping
from vacante.models import RawPost
from vacante.parse import parse_post
from vacante.site import build as site
from vacante.store import MAX_AGE_DAYS

NOW = datetime(2026, 10, 27, 12, tzinfo=timezone.utc)


def post(post_id: int, text: str, city: str | None = "almaty", hours_ago: float = 3, channel: str = "chan"):
    """Вакансия из поста канала, опубликованного hours_ago часов назад."""
    raw = RawPost("telegram", channel, post_id, f"https://t.me/{channel}/{post_id}", text,
                  NOW - timedelta(hours=hours_ago), city)
    return parse_post(raw)


def test_job_posting_is_valid_while_the_page_lives():
    """validThrough — день, когда страница уйдёт с сайта: тот же срок, что у сбора, а не 30 дней."""
    v = replace(post(1, "Кафе «Зерно» ищет официанта, 250 000 тг"), employer="Зерно",
                posted_at="2026-10-27T09:00:00+00:00")
    assert MAX_AGE_DAYS == 14 and inspect.signature(collect.run).parameters["max_age_days"].default == MAX_AGE_DAYS
    assert json.loads(site.job_posting_ld(v, "https://vacante.kz"))["validThrough"] == "2026-11-10T09:00:00+00:00"
    # Оплаченное «🔥 Срочно» держит вакансию на сайте дольше срока (store.expire): объявление действует до его конца
    top = replace(v, top_until="2026-11-20T10:00:00+00:00")
    assert json.loads(site.job_posting_ld(top, "https://vacante.kz"))["validThrough"] == "2026-11-20T10:00:00+00:00"
    short = replace(v, top_until="2026-10-30T10:00:00+00:00")
    assert json.loads(site.job_posting_ld(short, "https://vacante.kz"))["validThrough"] == "2026-11-10T09:00:00+00:00"


def test_shift_for_a_day_is_valid_until_that_day_ends():
    """Смена на конкретный день уходит с сайта, когда день прошёл (время Казахстана), а не через две недели."""
    shift = direct.to_vacancy({"id": 9, "kind": "shift", "city": "almaty", "title": "официант", "company": "Кафе «Зерно»",
                               "salary": "12 000 ₸ за смену", "approved_at": "2026-11-06 07:00:00",
                               "shift_date": "2026-11-07", "shift_start": "10:00", "shift_end": "22:00", "need": 3})
    data = json.loads(site.job_posting_ld(shift, "https://vacante.kz"))
    assert data["validThrough"] == "2026-11-08T00:00:00+05:00" and data["datePosted"] == "2026-11-06"


def test_search_ping_records_removed_urls_for_indexnow_only(tmp_path, monkeypatch, capsys):
    """diff пишет новые адреса и после пустой строки снятые; send отдаёт IndexNow и те и другие, Google — только новые."""
    url = lambda *paths: "".join(f"<url><loc>https://vacante.kz/{p}</loc></url>" for p in paths)  # noqa: E731
    (tmp_path / "old.xml").write_text(url("", "v/a-1/", "kk/v/a-1/", "almaty/povar/"), "utf-8")
    (tmp_path / "new.xml").write_text(url("", "v/a-2/", "kk/v/a-2/", "v/hh-5/"), "utf-8")
    out = tmp_path / "urls.txt"
    searchping.main(["diff", str(tmp_path / "old.xml"), str(tmp_path / "new.xml"), str(out)])
    assert "новых адресов: 3, снятых: 3" in capsys.readouterr().out
    assert out.read_text("utf-8") == ("https://vacante.kz/v/a-2/\nhttps://vacante.kz/kk/v/a-2/\nhttps://vacante.kz/v/hh-5/\n\n"
                                      "https://vacante.kz/v/a-1/\nhttps://vacante.kz/kk/v/a-1/\nhttps://vacante.kz/almaty/povar/")
    sent = {}

    def record(name: str):
        def step(client, urls):
            sent[name] = urls
            return f"{name}: {len(urls)}"
        return step

    monkeypatch.setattr(searchping, "indexnow", record("indexnow"))
    monkeypatch.setattr(searchping, "google_index", record("google"))
    searchping.main(["send", str(out)])
    assert sent["indexnow"] == ["https://vacante.kz/v/a-2/", "https://vacante.kz/kk/v/a-2/", "https://vacante.kz/v/hh-5/",
                                "https://vacante.kz/v/a-1/", "https://vacante.kz/kk/v/a-1/", "https://vacante.kz/almaty/povar/"]
    assert sent["google"] == ["https://vacante.kz/v/a-2/", "https://vacante.kz/kk/v/a-2/", "https://vacante.kz/v/hh-5/"]
    assert searchping.google_order(sent["google"]) == ["https://vacante.kz/v/a-2/"]


def test_search_ping_file_stays_compatible_both_ways(tmp_path, capsys):
    """Без снятых адресов файл такой же, как раньше; файл прошлого формата читается как «все адреса новые»."""
    assert searchping.join_urls(["https://vacante.kz/v/a-2/", "https://vacante.kz/v/a-3/"], []) == (
        "https://vacante.kz/v/a-2/\nhttps://vacante.kz/v/a-3/")
    assert searchping.split_urls("https://vacante.kz/v/a-2/\nhttps://vacante.kz/v/a-3/") == (
        ["https://vacante.kz/v/a-2/", "https://vacante.kz/v/a-3/"], [])
    assert searchping.split_urls("") == ([], [])
    # Только снятые: файл не пуст (шаг отправки в update.yml пропускает пустой файл), новых в нём нет
    only_gone = searchping.join_urls([], ["https://vacante.kz/v/a-1/"])
    assert only_gone.strip() and searchping.split_urls(only_gone) == ([], ["https://vacante.kz/v/a-1/"])
    # Прошлая версия send читала файл как text.split(): в новом формате это по-прежнему только адреса сайта
    both = searchping.join_urls(["https://vacante.kz/v/a-2/"], ["https://vacante.kz/v/a-1/"])
    assert both.split() == ["https://vacante.kz/v/a-2/", "https://vacante.kz/v/a-1/"]
    # Прошлой карты сайта нет (не скачалась): отправлять нечего, снятым ничего не считаем
    (tmp_path / "new.xml").write_text("<url><loc>https://vacante.kz/</loc></url>", "utf-8")
    searchping.main(["diff", str(tmp_path / "нет.xml"), str(tmp_path / "new.xml"), str(tmp_path / "urls.txt")])
    assert (tmp_path / "urls.txt").read_text("utf-8") == "" and "прошлой карты сайта нет" in capsys.readouterr().out


def test_indexnow_keeps_the_request_limit_and_new_urls_go_first():
    """В один запрос IndexNow идёт не больше 10 000 адресов: сначала новые, снятые — на оставшееся место."""
    new = [f"https://vacante.kz/v/a-{i}/" for i in range(9_998)]
    gone = [f"https://vacante.kz/v/b-{i}/" for i in range(5)]
    seen = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(202)

    with httpx.Client(transport=httpx.MockTransport(answer)) as client:
        assert searchping.indexnow(client, new + gone) == "IndexNow: 10000 адресов, ответ 202"
        assert searchping.indexnow(client, []) == "IndexNow: новых и снятых адресов нет"
    assert len(seen) == 1 and seen[0]["host"] == "vacante.kz" and seen[0]["key"] == site.INDEXNOW_KEY
    assert seen[0]["urlList"] == new + gone[:2]

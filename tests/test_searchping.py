"""Отчёты Search Console (vacante/searchping.py): что считаем из ответов Google."""

import httpx

from vacante import searchping


def test_daily_report_groups_impressions_by_kind_of_page():
    rows = [
        {"keys": ["2026-11-10", "https://vacante.kz/"], "impressions": 30, "clicks": 2},
        {"keys": ["2026-11-10", "https://vacante.kz/almaty/"], "impressions": 40, "clicks": 1},
        {"keys": ["2026-11-10", "https://vacante.kz/kk/almaty/"], "impressions": 5, "clicks": 0},
        {"keys": ["2026-11-10", "https://vacante.kz/v/hh-1/"], "impressions": 100, "clicks": 3},
        {"keys": ["2026-11-11", "https://vacante.kz/kk/v/kanal-7/"], "impressions": 9, "clicks": 0},
    ]
    days = searchping.by_kind_and_day(rows)
    # Русская и казахская версии складываются в один вид, казахские показы видны отдельным числом
    assert days["2026-11-10"]["kinds"] == {"главная": 30, "город или раздел": 45, "вакансия hh": 100}
    assert (days["2026-11-10"]["kk"], days["2026-11-10"]["pages"]) == (5, 4)
    assert days["2026-11-11"]["kinds"] == {"вакансия из каналов и от работодателей": 9}
    assert (days["2026-11-11"]["kk"], days["2026-11-11"]["pages"]) == (9, 1)
    assert {kind for _, kind in searchping.DAILY_COLUMNS} >= set(days["2026-11-10"]["kinds"])


def test_search_rows_are_read_page_by_page_until_a_short_page(monkeypatch):
    monkeypatch.setattr(searchping, "SEARCH_ROWS", 2)
    asked = []

    def answer(request: httpx.Request) -> httpx.Response:
        import json
        body = json.loads(request.content)
        asked.append((body["startRow"], body["rowLimit"], body["dimensions"]))
        rows = [{"keys": ["a"]}, {"keys": ["b"]}, {"keys": ["c"]}][body["startRow"]:body["startRow"] + 2]
        return httpx.Response(200, json={"rows": rows})

    with httpx.Client(transport=httpx.MockTransport(answer)) as client:
        rows = searchping._search_rows(client, "https://gsc.test", {}, {"dimensions": ["query"]})
    assert [row["keys"][0] for row in rows] == ["a", "b", "c"]
    assert asked == [(0, 2, ["query"]), (2, 2, ["query"])]
    # Отказ Google возвращается текстом, отчёт печатает его и идёт дальше
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(403, text="нет доступа"))) as client:
        assert searchping._search_rows(client, "https://gsc.test", {}, {}) == "ошибка 403 нет доступа"


def test_crawl_days_count_only_pages_the_robot_visited():
    days = searchping.crawl_days([("вакансия hh", "2026-11-09T10:00:00Z"), ("город или раздел", "2026-11-09T23:59:59Z"),
                                  ("вакансия hh (kk)", "2026-11-25T01:00:00Z"), ("главная", None)])
    assert days == {"2026-11-09": (2, 1), "2026-11-25": (1, 1)}

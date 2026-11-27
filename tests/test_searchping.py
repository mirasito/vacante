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


def test_indexing_api_table_splits_pages_by_notification_and_markup():
    # (сообщали, есть разметка, робот заходил, в индексе)
    pages = [(True, True, True, True), (True, True, False, False), (True, False, False, False), (False, False, True, False)]
    assert searchping.notified_table(pages) == [
        ("сообщали, с разметкой", 2, 1, 1), ("сообщали, без разметки", 1, 0, 0),
        ("не сообщали, с разметкой", 0, 0, 0), ("не сообщали, без разметки", 1, 1, 0)]


def test_notification_time_and_job_markup_are_read_from_google_and_the_live_page():
    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.host == "indexing.googleapis.com":
            if request.url.params["url"].endswith("/v/a-1/"):
                return httpx.Response(200, json={"url": "x", "latestUpdate": {"type": "URL_UPDATED", "notifyTime": "2026-11-25T05:28:09Z"}})
            if request.url.params["url"].endswith("/v/a-3/"):
                return httpx.Response(403, json={"error": {"code": 403, "message": "Permission denied.\nFailed to verify"}})
            return httpx.Response(404, json={"error": {"code": 404}})
        return httpx.Response(200, text='<script type="application/ld+json">{"@type": "JobPosting"}</script>'
                              if request.url.path == "/v/a-1/" else "<p>без разметки</p>")

    with httpx.Client(transport=httpx.MockTransport(answer)) as client:
        assert searchping._notified(client, {}, "https://vacante.kz/v/a-1/") == (200, "2026-11-25T05:28:09Z")
        assert searchping._notified(client, {}, "https://vacante.kz/v/a-2/") == (404, None)
        # Отказ Google не должен выглядеть как «не сообщали»: код и начало текста видны в отчёте
        code, text = searchping._notified(client, {}, "https://vacante.kz/v/a-3/")
        assert code == 403 and "Permission denied. Failed to verify" in text
        assert searchping._has_job_markup(client, "https://vacante.kz/v/a-1/")
        assert not searchping._has_job_markup(client, "https://vacante.kz/v/a-2/")


def test_notifications_are_counted_by_the_day_the_vacancy_was_published():
    answers = [("2026-11-25", 200, "2026-11-25T05:28:09Z"), ("2026-11-25", 404, None), ("2026-11-26", 403, "Permission denied"),
               ("2026-11-26", 200, None), ("2026-11-24", 0, "ConnectTimeout")]
    # Сообщение дошло — только ответ 200 со временем сообщения об обновлении
    assert searchping.notify_days(answers) == [("2026-11-24", 1, 0), ("2026-11-25", 2, 1), ("2026-11-26", 2, 0)]


def test_probe_tells_google_about_two_newest_own_vacancies_and_asks_whether_it_was_recorded(monkeypatch, capsys):
    sitemap = ("<url><loc>https://vacante.kz/almaty/</loc><lastmod>2026-11-27</lastmod></url>"
               "<url><loc>https://vacante.kz/v/hh-1/</loc><lastmod>2026-11-27</lastmod></url>"
               "<url><loc>https://vacante.kz/v/kanal-9/</loc><lastmod>2026-11-27</lastmod></url>"
               "<url><loc>https://vacante.kz/v/kanal-8/</loc><lastmod>2026-11-26</lastmod></url>"
               "<url><loc>https://vacante.kz/v/kanal-7/</loc><lastmod>2026-11-26</lastmod></url>"
               "<url><loc>https://vacante.kz/v/kanal-6/</loc><lastmod>2026-11-26</lastmod></url>")
    told = []

    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.host == "indexing.googleapis.com" and request.method == "POST":
            import json
            told.append(json.loads(request.content))
            return httpx.Response(200, json={"urlNotificationMetadata": {"url": told[-1]["url"]}})
        if request.url.host == "indexing.googleapis.com":
            # Google принял сообщение, но на вопрос о нём отвечает «не сообщали»: это и должно быть видно
            return httpx.Response(404, json={"error": {"code": 404, "message": "Requested entity was not found."}})
        if request.url.path == "/sitemap.xml":
            return httpx.Response(200, text=sitemap)
        return httpx.Response(200, text='<script type="application/ld+json">{"@type": "JobPosting"}</script>'
                              if request.url.path in ("/v/kanal-7/", "/v/kanal-6/") else "<p>вакансия</p>")

    real_client, transport = httpx.Client, httpx.MockTransport(answer)
    monkeypatch.setattr(searchping.httpx, "Client", lambda **kw: real_client(transport=transport))
    monkeypatch.setattr(searchping, "service_account", lambda: {"client_email": "a@b"})
    monkeypatch.setattr(searchping, "google_token", lambda client, account: "t")
    monkeypatch.setattr(searchping, "PROBE_WAITS", (0, 0))
    searchping.main(["probe"])
    out = capsys.readouterr().out
    # Сообщаем о двух страницах: самой новой своей вакансии без разметки и самой новой с разметкой.
    # Не о копии hh и не о списке
    assert told == [{"url": "https://vacante.kz/v/kanal-9/", "type": "URL_UPDATED"},
                    {"url": "https://vacante.kz/v/kanal-7/", "type": "URL_UPDATED"}]
    assert "kanal-9/, разметка JobPosting на ней нет" in out and "kanal-7/, разметка JobPosting на ней есть" in out
    # Фигурных скобок в журнале нет: GitHub закрыл бы их звёздочками
    assert 'сообщение отправлено: ответ 200 "urlNotificationMetadata"' in out and "{" not in out and "}" not in out
    assert out.count("Google отвечает о ней: 404") == 6


def test_hourly_send_tells_google_only_about_pages_with_job_markup_and_says_whether_it_was_recorded(monkeypatch):
    urls = ["https://vacante.kz/almaty/", "https://vacante.kz/v/hh-1/", "https://vacante.kz/kk/v/kanal-3/",
            "https://vacante.kz/v/kanal-3/", "https://vacante.kz/v/kanal-2/", "https://vacante.kz/v/kanal-1/"]
    told, recorded = [], {"yes": False}

    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.host == "indexing.googleapis.com" and request.method == "POST":
            import json
            told.append(json.loads(request.content)["url"])
            return httpx.Response(200, json={"urlNotificationMetadata": {"url": told[-1]}})
        if request.url.host == "indexing.googleapis.com":
            if recorded["yes"]:
                return httpx.Response(200, json={"latestUpdate": {"notifyTime": "2026-11-27T06:28:09Z"}})
            return httpx.Response(404, json={"error": {"code": 404, "message": "Requested entity was not found."}})
        # Разметка есть у вакансий с работодателем: kanal-3 без неё
        return httpx.Response(200, text="<p>вакансия</p>" if request.url.path == "/v/kanal-3/"
                              else '<script type="application/ld+json">{"@type": "JobPosting"}</script>')

    monkeypatch.setattr(searchping, "service_account", lambda: {"client_email": "a@b"})
    monkeypatch.setattr(searchping, "google_token", lambda client, account: "t")
    monkeypatch.setattr(searchping, "RECORD_PAUSE", 0)
    with httpx.Client(transport=httpx.MockTransport(answer)) as client:
        # Google ответил 200, но на вопрос о сообщении говорит «не сообщали»: в журнале это видно
        line = searchping.google_index(client, urls)
        assert told == ["https://vacante.kz/v/kanal-2/", "https://vacante.kz/v/kanal-1/"]
        assert line == ("Google Indexing API: 2 адресов с разметкой JobPosting из 3 новых своих вакансий, "
                        "ответы [200], сообщение Google не записал (на вопрос о сообщении ответ 404)")
        recorded["yes"] = True
        assert searchping.google_index(client, urls).endswith("ответы [200], сообщение Google записал")
        # Страниц с разметкой среди новых нет: ничего не отправляем
        told.clear()
        assert searchping.google_index(client, urls[:4]) == (
            "Google Indexing API: среди 1 новых своих вакансий нет страниц с разметкой JobPosting")
        assert told == []

import httpx

from vacante import metrika


def test_summary_has_click_and_telegram_reports_and_survives_a_failed_one(monkeypatch, capsys):
    asked = []

    def handler(request: httpx.Request) -> httpx.Response:
        params = dict(request.url.params)
        asked.append(params)
        if params["dimensions"] == "ym:s:paramsLevel1,ym:s:paramsLevel2":
            return httpx.Response(400, json={"message": "Wrong parameter: 'dimensions'"})
        row = {"dimensions": [{"name": "channel"}, {"name": "post"}, {"name": None}], "metrics": [12.0, 9.5]}
        return httpx.Response(200, json={"data": [row], "totals": [12.0, 9.5]})

    client = httpx.Client
    monkeypatch.setattr(metrika.httpx, "Client", lambda **kw: client(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setenv("METRIKA_TOKEN", "token")
    # Один отчёт Метрика не приняла: в сводке строка с ошибкой, остальные отчёты на месте
    assert metrika.main() == 0
    out = capsys.readouterr().out
    assert "--- параметры визитов: нажатия на кнопки отклика и переходы в форму размещения\n    ошибка 400 Wrong" in out
    assert "--- ссылки из Telegram: utm_medium / utm_campaign / utm_content\n    channel / post / —: 12, 9.5" in out
    assert out.count("\n--- ") == len(metrika.REPORTS) == len(asked)
    by_dimensions = {p["dimensions"]: p for p in asked}
    # Нажатия на кнопки отклика и переходы в форму размещения: параметры визитов, которые шлёт static/via.js
    assert by_dimensions["ym:s:paramsLevel1,ym:s:paramsLevel2"]["metrics"] == "ym:s:visits,ym:s:users"
    assert "ym:s:paramsLevel1,ym:s:lastTrafficSource" in by_dimensions
    # Свои ссылки из Telegram: канал или бот, вид сообщения, город
    assert by_dimensions["ym:s:lastUTMMedium,ym:s:lastUTMCampaign,ym:s:lastUTMContent"]["filters"] == (
        "ym:s:lastUTMSource=='telegram'")
    assert by_dimensions["ym:s:isNewUser"]["metrics"] == "ym:s:visits,ym:s:users"

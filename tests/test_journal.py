import json
from datetime import datetime, timezone

import httpx
import pytest

from vacante import collect
from vacante.journal import snippet
from vacante.models import RawPost
from vacante.parse import REJECT_REASONS, explain
from vacante.site.build import build

NOW = datetime(2026, 10, 27, 12, tzinfo=timezone.utc)
BARISTA = "Требуется бариста в кофейню «Зерно», 2/2, 12 000 тг за смену, обучение"


def raw(channel: str, post_id: int, text: str, hour: int = 9) -> RawPost:
    return RawPost("telegram", channel, post_id, f"https://t.me/{channel}/{post_id}", text,
                   datetime(2026, 10, 27, hour, tzinfo=timezone.utc), "almaty")


@pytest.mark.parametrize("text, reason", [
    ("Ищу работу официантом, опыт 3 года", "not_vacancy"),
    ("Работа в телефоне без вложений! Нужен курьер", "scam"),
    ("Всем доброе утро, хорошего дня!", "no_profession"),
    ("Официант Айгерим — лучший сотрудник месяца", "no_hiring"),
    ("Требуется инженер по охране труда, водитель служебного авто, 300 000 тг", "white_collar"),
    ("#вахтаРоссия Требуются разнорабочие, 23 000 тенге за смену. Выезд из города #Костанай", "abroad"),
    ("Требуется официант в ресторан в Ташкенте, оплата 5 000 000 сум", "foreign"),
])
def test_explain_names_the_reason(text, reason):
    vacancy, why = explain(raw("chan", 1, text))
    assert vacancy is None and why == reason and why in REJECT_REASONS


def test_explain_accepts_vacancy():
    vacancy, why = explain(raw("chan", 1, BARISTA))
    assert vacancy.title == "Бариста" and why is None


def test_snippet_has_no_phones_and_is_short():
    text = "Требуется повар\nЗвоните +7 701 123 45 67\n" + "Очень длинное описание " * 20
    s = snippet(text)
    assert s.startswith("Требуется повар · Звоните") and "701" not in s and len(s) <= 140


def run_collect(tmp_path, posts_by_channel, calls=None):
    config = tmp_path / "channels.yaml"
    config.write_text("channels:\n" + "".join(f"  - username: {c}\n    city: almaty\n" for c in posts_by_channel), "utf-8")

    def fetch(client, name, city, since_id=0, max_age_days=14):
        if calls is not None:
            calls.append((name, since_id))
        posts = posts_by_channel[name]
        if isinstance(posts, Exception):
            raise posts
        return [p for p in posts if p.post_id > since_id]

    return collect.run(config, tmp_path / "data", fetch=fetch, now=NOW)


def test_collect_records_every_post_with_its_fate(tmp_path):
    calls = []
    channels = {
        "chan_a": [raw("chan_a", 1, BARISTA, 8), raw("chan_a", 2, "Ищу работу официантом, опыт 3 года")],
        "chan_b": [raw("chan_b", 5, BARISTA + "\nПодписывайтесь на канал"),
                   raw("chan_b", 6, "Требуется инженер по охране труда, водитель, 300 000 тг")],
        "chan_c": httpx.ConnectError("нет связи"),
    }
    run_collect(tmp_path, channels, calls)
    journal = json.loads((tmp_path / "data" / "journal.json").read_text("utf-8"))
    fate = {p["id"]: (p["status"], p["reason"], p["vacancy"]) for p in journal["posts"]}
    assert fate == {
        "chan_a-1": ("accepted", None, "chan_a-1"),
        "chan_a-2": ("rejected", "not_vacancy", None),
        "chan_b-5": ("duplicate", None, "chan_a-1"),
        "chan_b-6": ("rejected", "white_collar", None),
    }
    assert journal["channels"]["chan_a"]["new_posts"] == 2 and journal["channels"]["chan_a"]["error"] is None
    assert journal["channels"]["chan_c"]["error"] == "ConnectError"

    # Дальше каналы читаются с последнего поста, а журнал дополняется
    calls.clear()
    channels["chan_a"].append(raw("chan_a", 3, "Требуется повар, 400 000 тг", 11))
    channels["chan_c"] = []
    run_collect(tmp_path, channels, calls)
    assert ("chan_a", 2) in calls
    journal = json.loads((tmp_path / "data" / "journal.json").read_text("utf-8"))
    assert len(journal["posts"]) == 5 and journal["channels"]["chan_c"]["error"] is None


def test_first_run_with_journal_rereads_channels_without_duplicating(tmp_path):
    channels = {"chan_a": [raw("chan_a", 1, BARISTA)]}
    run_collect(tmp_path, channels)
    (tmp_path / "data" / "journal.json").unlink()  # как при первом запуске после выкладки админки
    calls = []
    run_collect(tmp_path, channels, calls)
    assert calls == [("chan_a", 0)]
    vacancies = json.loads((tmp_path / "data" / "vacancies.json").read_text("utf-8"))
    assert [v["id"] for v in vacancies] == ["chan_a-1"] and vacancies[0]["also_seen_in"] == []


def test_card_dropped_by_new_rules_is_marked_rejected(tmp_path, monkeypatch):
    channels = {"chan_a": [raw("chan_a", 1, BARISTA)]}
    run_collect(tmp_path, channels)
    # Правила разбора ужесточились: та же карточка при повторном разборе отбрасывается
    monkeypatch.setattr(collect, "explain", lambda post: (None, "white_collar"))
    run_collect(tmp_path, channels)
    journal = json.loads((tmp_path / "data" / "journal.json").read_text("utf-8"))
    assert [(p["status"], p["reason"]) for p in journal["posts"]] == [("rejected", "white_collar")]


def test_admin_page_and_data(tmp_path):
    channels = {
        "chan_a": [raw("chan_a", 1, BARISTA, 8), raw("chan_a", 2, "Ищу работу официантом, опыт 3 года")],
        "chan_b": [raw("chan_b", 5, BARISTA + "\nПодписывайтесь на канал")],
    }
    run_collect(tmp_path, channels)
    data = tmp_path / "data"
    (data / "bot.json").write_text(json.dumps({"updated_at": NOW.isoformat(), "subscribers": [
        {"city": "almaty", "total": 3, "active": 2}, {"city": None, "total": 1, "active": 1}]}), "utf-8")
    build(data, tmp_path / "out", now=NOW)

    page = (tmp_path / "out" / "admin" / "index.html").read_text("utf-8")
    assert 'name="robots" content="noindex, nofollow"' in page and "mc.yandex" not in page
    assert "/admin/" not in (tmp_path / "out" / "sitemap.xml").read_text("utf-8")

    admin = json.loads((tmp_path / "out" / "admin" / "data.json").read_text("utf-8"))
    t = admin["totals"]
    assert (t["on_site"], t["posts"], t["accepted"], t["duplicate"], t["rejected"], t["new_24h"]) == (1, 3, 1, 1, 1, 1)
    a = next(s for s in admin["sources"] if s["name"] == "chan_a")
    assert (a["posts"], a["accepted"], a["rejected"], a["on_site"], a["city"]) == (2, 1, 1, 1, "Алматы")
    assert admin["reasons"] == [{"code": "not_vacancy", "label": "Резюме или объявление", "count": 1}]
    assert admin["by_city"] == [["Алматы", 1]]
    assert [s["city"] for s in admin["bot"]["subscribers"]] == ["Алматы", "Весь Казахстан"]
    assert [a["city"] for a in admin["autopost"]] == ["Астана", "Алматы"]


def test_parser_change_rereads_channels(tmp_path, monkeypatch):
    channels = {"chan_a": [raw("chan_a", 1, BARISTA)]}
    run_collect(tmp_path, channels)
    calls = []
    run_collect(tmp_path, channels, calls)
    assert calls == [("chan_a", 1)]
    monkeypatch.setattr(collect, "parser_version", lambda: "new-rules")
    calls.clear()
    run_collect(tmp_path, channels, calls)
    assert calls == [("chan_a", 0)]

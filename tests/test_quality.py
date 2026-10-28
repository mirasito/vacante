import json
from datetime import datetime, timezone
from pathlib import Path

from vacante import collect, parse, quality
from vacante.models import RawPost

NOW = datetime(2026, 10, 27, 12, tzinfo=timezone.utc)
BARISTA = "Требуется бариста в кофейню «Зерно», 2/2, 12 000 тг за смену, обучение"
NANNY = "Требуется гувернантка, 17 000 тг за выход\nЗвоните +7 701 123 45 67"


def raw(channel: str, post_id: int, text: str, hour: int = 9) -> RawPost:
    return RawPost("telegram", channel, post_id, f"https://t.me/{channel}/{post_id}", text,
                   datetime(2026, 10, 27, hour, tzinfo=timezone.utc), "almaty")


def run_collect(tmp_path, posts_by_channel, calls=None):
    config = tmp_path / "channels.yaml"
    config.write_text("channels:\n" + "".join(f"  - username: {c}\n    city: almaty\n" for c in posts_by_channel), "utf-8")

    def fetch(client, name, city, since_id=0, max_age_days=14):
        if calls is not None:
            calls.append((name, since_id))
        return [p for p in posts_by_channel[name] if p.post_id > since_id]

    return collect.run(config, tmp_path / "data", fetch=fetch, now=NOW)


def rejected(tmp_path) -> dict:
    return {p["id"]: p for p in json.loads((tmp_path / "data" / "rejected.json").read_text("utf-8"))}


def test_collect_keeps_clean_text_of_rejected_posts(tmp_path):
    run_collect(tmp_path, {"chan_a": [raw("chan_a", 1, BARISTA), raw("chan_a", 2, NANNY),
                                      raw("chan_a", 3, "Ищу работу официантом, опыт 3 года")]})
    items = rejected(tmp_path)
    assert sorted(items) == ["chan_a-2", "chan_a-3"]
    assert items["chan_a-2"]["reason"] == "no_profession" and items["chan_a-2"]["city"] == "almaty"
    assert "гувернантка" in items["chan_a-2"]["text"] and "701" not in items["chan_a-2"]["text"]
    assert items["chan_a-3"]["reason"] == "not_vacancy"


def test_rejected_texts_follow_rule_changes(tmp_path, monkeypatch):
    channels = {"chan_a": [raw("chan_a", 1, BARISTA), raw("chan_a", 2, NANNY)]}
    run_collect(tmp_path, channels)
    # Новые правила: гувернантка стала вакансией, а бариста больше нет
    real = parse.explain
    monkeypatch.setattr(collect, "parser_version", lambda: "new-rules")
    monkeypatch.setattr(collect, "explain", lambda post: (None, "white_collar") if "бариста" in post.text
                        else real(RawPost(post.source, post.channel, post.post_id, post.url,
                                          post.text.replace("гувернантка", "уборщица"), post.posted_at,
                                          post.default_city)))
    run_collect(tmp_path, channels)
    items = rejected(tmp_path)
    assert list(items) == ["chan_a-1"] and items["chan_a-1"]["reason"] == "white_collar"
    assert "бариста" in items["chan_a-1"]["text"]


def test_missing_rejected_file_rereads_channels(tmp_path):
    channels = {"chan_a": [raw("chan_a", 1, BARISTA)]}
    run_collect(tmp_path, channels)
    calls = []
    run_collect(tmp_path, channels, calls)
    assert calls == [("chan_a", 1)]
    (tmp_path / "data" / "rejected.json").unlink()  # как при первом запуске после выкладки
    calls.clear()
    run_collect(tmp_path, channels, calls)
    assert calls == [("chan_a", 0)]


def test_report_shows_numbers_flags_and_examples(tmp_path):
    run_collect(tmp_path, {
        "chan_a": [raw("chan_a", 1, BARISTA), raw("chan_a", 2, "Требуется сотрудник в магазин, 200 000 тг")],
        "chan_b": [raw("chan_b", i, NANNY + f" №{i}") for i in range(1, 7)],
    })
    text = quality.report(tmp_path / "data", now=NOW)
    assert "| постов | 8 | 8 |" in text and "| — no_profession (Нет рабочей профессии) | 6 | 6 |" in text
    assert "| ⚠ chan_b | almaty | 6 | 0 (0%) |" in text and "| chan_a | almaty | 2 | 2 (100%) |" in text
    assert "https://t.me/chan_b/" in text and "гувернантка" in text
    assert "### Должность «Сотрудник» (1)" in text and "https://t.me/chan_a/2: **Сотрудник**" in text


def test_replay_shows_what_a_rule_change_does(tmp_path):
    run_collect(tmp_path, {"chan_a": [raw("chan_a", 1, BARISTA), raw("chan_a", 2, NANNY)]})
    source = Path(parse.__file__).read_text("utf-8")
    assert quality.replay(tmp_path / "data", quality.load_parser(source))[0] == {}

    new = quality.load_parser(source.replace(
        '(r"бариста", "Бариста", "horeca"),', '(r"бариста", "Бариста", "horeca"),\n    (r"гувернантк", "Гувернантка", "service"),'
    ), "vacante_parse_new")
    counts, text = quality.replay(tmp_path / "data", parse, new)
    assert counts == {"стало принято": 1}
    assert "https://t.me/chan_a/2: отброшено (no_profession) → принято: **Гувернантка**" in text

from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest

from vacante import video
from vacante.models import RawPost
from vacante.parse import parse_post

NOW = datetime(2026, 11, 16, 3, tzinfo=timezone.utc)  # 8:00 в Казахстане


def make(post_id: int, text: str, city: str = "almaty", hours_ago: int = 5):
    raw = RawPost("telegram", "chan", post_id, f"https://t.me/chan/{post_id}", text, NOW - timedelta(hours=hours_ago), city)
    return parse_post(raw)


def cooks(n: int, start: int = 0):
    return [make(100 + start + i, f"Кафе «Зерно {start + i}» ищет повара, {250 + 10 * i} 000 тг, 2/2, питание")
            for i in range(n)]


def test_role_is_read_from_title():
    assert video.role_of(make(1, "Ресторан «Сад» ищет повара горячего цеха, 300 000 тг")) == "Повар"
    assert video.role_of(make(2, "Кофейня «Зерно» ищет бариста, 12 000 тг за смену")) == "Бариста"
    assert video.role_of(make(3, "Требуется грузчик на склад, 300 000 тг")) is None
    # Руководящие должности в рядовые не считаем: иначе «повар» получает зарплату шефа
    assert video.role_of(replace(make(4, "Ресторан «Сад» ищет повара"), title="Шеф-повар")) is None


def test_list_clip_has_a_slide_per_vacancy_and_a_caption_with_tracked_link():
    items = cooks(6)
    clips = video.plan(items, items, NOW)
    clip = clips[0]
    assert clip.name == "2026-11-16-almaty-vakansii-povar"
    assert [s.title for s in clip.slides][0] == "5 вакансий повара в Алматы"
    assert len(clip.slides) == 1 + 5 + 1  # обложка, пять вакансий, концовка
    assert clip.slides[1].kicker.startswith("1 из 5 · ") and "₸" in clip.slides[1].big
    assert clip.slides[1].lines[0] == "График: 2/2"
    assert "5 вакансий повара в Алматы на 16 ноября" in clip.caption
    assert "https://t.me/vacantekz_bot?startapp=svid_c_almaty" in clip.caption
    assert clip.caption.endswith("#работаалматы #вакансииалматы #общепит #повар")
    assert 12 <= sum(s.seconds for s in clip.slides) <= 25


def test_list_clip_takes_only_fresh_almaty_horeca_with_pay_one_per_venue():
    same_venue = [make(200 + i, "Кафе «Луна» ищет официанта, 300 000 тг") for i in range(4)]
    old = [replace(v, posted_at=(NOW - timedelta(days=5)).isoformat()) for v in cooks(4)]
    astana = [replace(v, city="astana") for v in cooks(4, start=10)]
    no_pay = [make(300 + i, f"Кафе «Сад {i}» ищет бармена") for i in range(4)]
    assert video.plan(same_venue + old + astana + no_pay, [], NOW) == []
    assert len(video.plan(cooks(3), [], NOW)) == 1  # трёх вакансий достаточно
    assert video.plan(cooks(2), [], NOW) == []


def test_pay_clip_gives_the_middle_half_of_the_market():
    waiters = [make(400 + i, f"Кафе «Луна {i}» ищет официанта, {pay} 000 тг")
               for i, pay in enumerate([200, 220, 250, 260, 280, 300, 320, 350, 400, 600])]
    clip = video.pay_clip("Официант", waiters, NOW)
    assert clip.slides[0].title == "Сколько платят официанту в Алматы?"
    assert clip.slides[0].lines == ["Посчитали по 10 вакансиям за две недели"]
    assert clip.slides[1].big == "240 000 – 360 000 ₸"  # между четвертями, округлено до 10 000
    assert (clip.slides[2].title, clip.slides[2].big) == ("Каждая четвёртая вакансия", "от 360 000 ₸")
    # Заведений в ролике о зарплатах не называем
    assert not any("Луна" in text for s in clip.slides for text in [s.title, s.big, *s.lines])
    assert "Обычно 240 000 – 360 000 ₸ в месяц" in clip.caption
    # Оплата за смену пересчитана на месяц; опечатки в зарплате не считаются
    shift = make(420, "Кафе «Сад» ищет официанта, 15 000 тг за смену")
    assert video._monthly(shift) == (330_000, 330_000)
    assert video._monthly(replace(shift, salary_min=5_000_000, salary_max=None, salary_period="month")) is None
    assert video.pay_clip("Официант", waiters[:7], NOW) is None  # мало данных: не говорим


def test_two_clips_a_day_are_about_different_roles():
    waiters = [make(500 + i, f"Кафе «Луна {i}» ищет официанта, {250 + 10 * i} 000 тг") for i in range(9)]
    items = cooks(9) + waiters
    clips = video.plan(items, items, NOW)
    assert len(clips) == 2
    kinds = [c.name.split("-")[4] for c in clips]
    roles = [c.name.split("-")[5] for c in clips]
    assert kinds == ["vakansii", "zarplata"] and roles[0] != roles[1]


def test_frames_are_vertical_and_last_as_long_as_slides():
    slides = [video.Slide(title="5 вакансий повара в Алматы", seconds=0.5),
              video.Slide(kicker="1 из 5", title="Повар горячего цеха", big="от 300 000 ₸/мес", lines=["График: 2/2"], seconds=0.5)]
    got = list(video.frames(slides, fps=10))
    assert len(got) == 10 and got[0].size == (1080, 1920)
    assert got[5].tobytes() != got[9].tobytes()  # переход между слайдами и полоска сверху меняют кадр


def test_mp4_is_written_when_ffmpeg_is_available(tmp_path):
    if not video.ffmpeg_path():
        pytest.skip("нет ffmpeg")
    clip = video.Clip("demo", [video.Slide(title="Проверка", seconds=0.4)], "Подпись")
    (path,) = video.render([clip], tmp_path)
    assert path.read_bytes()[4:8] == b"ftyp" and (tmp_path / "demo.txt").read_text("utf-8") == "Подпись\n"


def test_clips_go_to_moderators_with_caption(tmp_path):
    import httpx

    clip = video.Clip("demo", [video.Slide(title="Проверка", seconds=0.4)], "Подпись")
    (tmp_path / "demo.mp4").write_bytes(b"mp4")
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.url.path.rsplit("/", 1)[1], request.content))
        return httpx.Response(200, json={"ok": True, "result": {}})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert video.send(client, "1:t", [900, 901], [clip], tmp_path) == {"sent": 2, "failed": 0}
    assert [name for name, _ in calls] == ["sendMessage", "sendVideo"] * 2
    assert "Подпись".encode() in calls[1][1] and b'filename="demo.mp4"' in calls[1][1]

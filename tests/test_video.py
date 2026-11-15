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
    # Первая строка — должность и сумма: от самой низкой до самой высокой зарплаты в ролике
    assert (clip.slides[0].title, clip.slides[0].big) == ("Повар в Алматы", "250\xa0000 – 290\xa0000 ₸")
    assert clip.slides[0].lines == ["в месяц", "5 свежих вакансий"]
    assert len(clip.slides) == 1 + 5 + 1  # обложка, пять вакансий, концовка
    assert clip.slides[1].kicker.startswith("1 из 5 · ") and "₸" in clip.slides[1].big
    assert clip.slides[1].lines[0] == "График: 2/2"
    first = clip.caption.split("\n")[0]
    assert first == "Повар в Алматы: 250\xa0000 – 290\xa0000 ₸ в месяц, 5 свежих вакансий на 16 ноября."
    assert len(first) <= 125  # столько лента показывает до «ещё»
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
    assert clip.name == "2026-11-16-almaty-zarplata-oficiant-a"
    assert clip.slides[0].title == "Сколько получает официант в Алматы?"
    assert clip.slides[0].lines == ["Посчитали по 10 вакансиям за две недели"]
    assert clip.caption.split("\n")[0] == "Сколько получает официант в Алматы? Обычно 240\xa0000 – 360\xa0000 ₸ в месяц."
    # На другой день первая строка — утверждение «должность: сумма»: сравниваем, что смотрят лучше
    other = video.pay_clip("Официант", waiters, NOW + timedelta(days=1))
    assert other.name.endswith("-b") and (other.slides[0].title, other.slides[0].big) == (
        "Официант в Алматы", "240\xa0000 – 360\xa0000 ₸")
    assert other.caption.startswith("Официант в Алматы: 240\xa0000 – 360\xa0000 ₸ в месяц по 10 вакансиям.")
    assert clip.slides[1].big == "240 000 – 360 000 ₸"  # между четвертями, округлено до 10 000
    assert (clip.slides[2].title, clip.slides[2].big) == ("Каждая четвёртая вакансия", "от 360 000 ₸")
    # Заведений в ролике о зарплатах не называем
    assert not any("Луна" in text for s in clip.slides for text in [s.title, s.big, *s.lines])
    assert "Каждая четвёртая — от 360\xa0000 ₸" in clip.caption
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
    assert all(len(c.caption.split("\n")[0]) <= 125 for c in clips)
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


def test_text_stays_inside_the_safe_zone_of_reels():
    # Сверху, снизу и справа ролик закрыт интерфейсом соцсети: там должен быть только фон
    slide = video.Slide(kicker="5 из 5 · Очень длинное название заведения на всю строку", title="Повар горячего цеха, "
                        "помощник повара, заготовщик и ещё должность", big="от 1 200 000 – 1 500 000 ₸/мес",
                        lines=["График: 2/2, с 08:00 до 23:00, ночные смены по желанию", "Питание · Развозка · Обучение",
                               "микрорайон Самал-2, улица очень длинная, дом 111"])
    frame = list(video.frames([slide, slide], fps=2))[-1]
    background = frame.getpixel((5, 5))
    for box in [(0, 0, video.W, video.SAFE_TOP), (0, video.SAFE_BOTTOM, video.W, video.H),
                (video.SAFE_RIGHT, 0, video.W, video.H)]:
        assert frame.crop(box).getcolors() == [(((box[2] - box[0]) * (box[3] - box[1])), background)]


# Третья тема: признаки, по которым объявление стоит перепроверить, с долей таких вакансий за неделю

def distinct(items):
    """Отпечаток текста не видит цифр, и одинаковые по словам объявления считались бы одним: разводим их."""
    return [replace(v, fingerprint=f"{v.fingerprint}-{i}") for i, v in enumerate(items)]


def week(no_pay: int = 10, wide: int = 5, ceiling: int = 1):
    """Неделя общепита Алматы: 40 вакансий с суммой (из них с вилкой вдвое и с одним «до») и вакансии без суммы."""
    paid = cooks(40)
    paid[:wide] = [replace(v, salary_min=200_000, salary_max=500_000) for v in paid[:wide]]
    paid[wide:wide + ceiling] = [replace(v, salary_min=None, salary_max=400_000) for v in paid[wide:wide + ceiling]]
    return paid + distinct(make(700 + i, f"Кафе «Сад {i}» ищет бармена, 2/2, питание") for i in range(no_pay))


def texts(clip):
    return [text for s in clip.slides for text in [s.kicker, s.title, s.big, *s.lines]] + [clip.caption]


def test_signs_clip_gives_the_share_of_vacancies_with_each_sign():
    clip = video.signs_clip(week(), NOW)
    assert clip.name == "2026-11-16-almaty-priznaki-summa"
    intro = clip.slides[0]
    # Первая строка — суть с цифрой, под ней — сколько вакансий посчитано
    assert (intro.title, intro.big, intro.lines[0]) == ("Вакансии общепита в Алматы", "20% — без суммы", "10 из 50 за неделю")
    assert [(s.title, s.big, s.lines) for s in clip.slides[1:3]] == [
        ("Нет суммы", "20% вакансий", ["10 из 50 за неделю", "Спросите сумму до собеседования"]),
        ("Только «до» или вилка вдвое", "12% вакансий", ["6 из 50 за неделю", "Спросите, сколько выходит обычно"])]
    assert len(clip.slides) == 1 + 2 + 1 + 1  # обложка, два признака, что спросить, концовка
    first = clip.caption.split("\n")[0]
    assert first == "20% вакансий общепита в Алматы за неделю — без суммы: 10 из 50."
    assert len(first) <= 125
    assert "— Только «до» или вилка вдвое: 12% (6 из 50 за неделю)." in clip.caption
    assert "https://t.me/vacantekz_bot?startapp=svid_c_almaty" in clip.caption
    assert clip.caption.endswith("#работаалматы #вакансииалматы #общепит #поискработы")
    assert 12 <= sum(s.seconds for s in clip.slides) <= 25
    # Главный признак меняется по дням, он же в имени файла: просмотры можно записывать по признакам
    other = video.signs_clip(week(), NOW + timedelta(days=1))
    assert other.name == "2026-11-17-almaty-priznaki-vilka" and other.slides[0].big == "12% — «до» или вилка вдвое"
    assert other.caption.startswith("12% вакансий общепита в Алматы за неделю — с суммой только «до» или вилкой вдвое: 6 из 50.")
    assert [s.title for s in other.slides[1:3]] == ["Только «до» или вилка вдвое", "Нет суммы"]


def test_signs_clip_names_no_venue_and_quotes_no_advert():
    # Ролик про признаки, а не про работодателя: ни названий, ни телефонов, ни текста объявлений
    items = week() + distinct(make(900 + i, f"Кафе «Мята {i}» ищет официанта. Стажировка 3 дня не оплачивается. "
                                             f"Тел. +7 701 555 00 0{i}") for i in range(5))
    clip = video.signs_clip(items, NOW)
    said = " ".join(texts(clip))
    assert not any(word in said for word in ("Зерно", "Сад", "Мята", "701", "Кафе", "3 дня"))
    assert "Стажировка без оплаты" in said


def test_signs_clip_needs_enough_vacancies_under_every_number():
    assert video.signs_clip(week()[:39], NOW) is None  # меньше 40 вакансий за неделю: долей не называем
    assert video.signs_clip(cooks(45), NOW) is None  # признаков нет: ролика нет
    # Признак меньше чем у пяти вакансий в ролик не попадает, остальные остаются
    few = video.signs_clip(week(no_pay=4), NOW)
    assert few.name.endswith("-priznaki-vilka") and not any("Нет суммы" in text for text in texts(few))
    assert [s.big for s in few.slides[:2]] == ["14% — «до» или вилка вдвое", "14% вакансий"] and few.slides[1].lines[0] == "6 из 44 за неделю"
    # Старше недели не считаем
    old = [replace(v, posted_at=(NOW - timedelta(days=8)).isoformat()) for v in week()]
    assert video.signs_clip(old, NOW) is None


def test_signs_clip_counts_a_repeated_advert_once_and_trusts_only_clear_cases():
    base = week()
    silent = base[-1]
    # То же объявление в другом канале и повтор того же заведения с той же должностью: считаем один раз
    again = [replace(silent, id="chan2-1"), replace(silent, id="chan-9001", fingerprint="другой текст")]
    # Разбор не нашёл сумму, но она в тексте есть: «без суммы» не считаем
    missed = replace(make(950, "Кафе «Лес» ищет повара, 300 000 тг"), salary_min=None, salary_max=None)
    # Вилка у объявления с несколькими должностями — это разные должности, а не разброс
    several = replace(make(951, "Кафе «Луг» ищет повара, 300 000 тг"), title="Повар, Мойщик", salary_min=150_000,
                      salary_max=400_000)
    # Опечатка в сумме не считается вилкой
    typo = replace(make(952, "Кафе «Бор» ищет повара, 300 000 тг"), salary_min=30_000, salary_max=3_000_000)
    clip = video.signs_clip(base + again + [missed, several, typo], NOW)
    assert [s.lines[0] for s in clip.slides[1:3]] == ["10 из 53 за неделю", "6 из 53 за неделю"]


def test_signs_from_the_text_are_counted_only_where_the_full_text_is_known():
    # У вакансий с hh.kz в базе только отрывок текста: про стажировку и залог по нему судить нельзя
    hh = [replace(v, source="hh") for v in cooks(30, start=100)]
    unpaid = distinct(make(900 + i, f"Кафе «Мята {i}» ищет официанта, 300 000 тг. Стажировка 3 дня не оплачивается") for i in range(5))
    paid = distinct(make(920 + i, f"Кафе «Роза {i}» ищет официанта, 300 000 тг. Оплачиваемая стажировка") for i in range(3))
    deposit = distinct(make(940 + i, f"Кафе «Ива {i}» ищет официанта, 300 000 тг. Залог за форму 10 000 тг") for i in range(5))
    clip = video.signs_clip(cooks(40) + hh + unpaid + paid + deposit, NOW)
    got = {s.title: (s.big, s.lines[0]) for s in clip.slides[1:-2]}
    assert got == {"Стажировка без оплаты": ("9% объявлений", "5 из 53 с полным текстом"),
                   "Залог или удержание": ("9% объявлений", "5 из 53 с полным текстом")}
    # Полных текстов меньше 40: по тексту не судим совсем
    assert video.signs_clip(cooks(30) + hh + unpaid, NOW) is None


def test_third_clip_goes_with_the_first_two_and_only_when_there_is_data():
    waiters = [make(500 + i, f"Кафе «Луна {i}» ищет официанта, {250 + 10 * i} 000 тг") for i in range(9)]
    items = week() + waiters
    clips = video.plan(items, items, NOW)
    assert [c.name.split("-")[4] for c in clips] == ["vakansii", "zarplata", "priznaki"]
    assert all(len(c.caption.split("\n")[0]) <= 125 for c in clips)
    # Вакансии другого города в долю не идут: данных на третий ролик нет, первые два выходят как раньше
    astana = [replace(v, city="astana") for v in week()]
    assert [c.name.split("-")[4] for c in video.plan(cooks(9) + waiters, cooks(9) + waiters + astana, NOW)] == [
        "vakansii", "zarplata"]


def test_signs_clip_stays_inside_the_safe_zone_and_is_not_cut():
    unpaid = distinct(make(900 + i, f"Кафе «Мята {i}» ищет официанта, 300 000 тг. Стажировка без оплаты") for i in range(5))
    deposit = distinct(make(940 + i, f"Кафе «Ива {i}» ищет официанта, 300 000 тг. Залог за форму 10 000 тг") for i in range(5))
    for day in range(4):  # каждый из четырёх признаков по очереди главный
        clip = video.signs_clip(week() + unpaid + deposit, NOW + timedelta(days=day))
        assert len(clip.slides) == 1 + 4 + 1 + 1 and sum(s.seconds for s in clip.slides) <= 25
        for slide in clip.slides:
            # Ничего не обрезано многоточием и не выброшено: на кадре весь текст слайда
            wanted = " ".join([slide.kicker, slide.title, slide.big, *slide.lines]).split()
            assert " ".join(video.fitted(slide)).split() == wanted
            frame = video.draw(slide)
            background = frame.getpixel((5, 5))
            for box in [(0, 0, video.W, video.SAFE_TOP), (0, video.SAFE_BOTTOM, video.W, video.H),
                        (video.SAFE_RIGHT, 0, video.W, video.H)]:
                assert frame.crop(box).getcolors() == [(((box[2] - box[0]) * (box[3] - box[1])), background)]

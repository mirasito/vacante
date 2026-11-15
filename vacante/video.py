"""Короткие вертикальные видео из собственных данных: для Reels, TikTok и Shorts.

Два вида роликов по общепиту Алматы, каждый день по одному:
- «5 вакансий повара в Алматы»: свежие вакансии одной должности, по слайду на вакансию;
- «Сколько платят официанту в Алматы»: зарплаты по своей базе за две недели.

Ролик — слайды 1080×1920 без звука, 15–20 секунд: кадры рисует Pillow, в mp4 их собирает ffmpeg.
Публикацию в соцсети код не делает: готовые ролики с подписями приходят модераторам в Telegram
(и лежат в артефактах запуска «Видео»), а выкладывает их человек. Ссылка в подписи ведёт в мини-приложение
с меткой источника «vid»: воронка показывает, сколько людей пришло с видео.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from statistics import quantiles

import httpx
from PIL import Image, ImageDraw

from vacante import autopost, launch
from vacante.card import BRAND, BRAND_SOFT, _font, _wrap
from vacante.models import Vacancy
from vacante.site.build import PER_MONTH, _locative, money, salary_label

log = logging.getLogger(__name__)

W, H, FPS, PAD = 1080, 1920, 30, 90
CITY, SPHERE = "almaty", "horeca"
SOURCE = "vid"  # метка источника в ссылке из подписи
FRESH = timedelta(hours=72)  # вакансии для ролика-списка
LIST_MAX, LIST_MIN = 5, 3
STATS_MIN = 8  # меньше восьми вакансий с зарплатой: про зарплаты не говорим
PAY_RANGE = (80_000, 1_500_000)  # в месяц; вне этого — опечатка или не зарплата
SECONDS = {"intro": 2.6, "item": 2.8, "outro": 3.2}
FADE = 0.35  # секунды перехода между слайдами
INK, SOFT, ACCENT = "white", BRAND_SOFT, "#ffd43b"

# Должность: по какому слову узнаём её в названии вакансии, родительный и дательный падеж, имя для файла
ROLES: dict[str, tuple[str, str, str, str]] = {
    "Повар": ("повар", "повара", "повару", "povar"),
    "Официант": ("официант", "официанта", "официанту", "oficiant"),
    "Бариста": ("бариста", "бариста", "бариста", "barista"),
    "Бармен": ("бармен", "бармена", "бармену", "barmen"),
    "Кассир": ("кассир", "кассира", "кассиру", "kassir"),
    "Пекарь": ("пекар", "пекаря", "пекарю", "pekar"),
    "Кондитер": ("кондитер", "кондитера", "кондитеру", "konditer"),
    "Сушист": ("сушист", "сушиста", "сушисту", "sushist"),
}
# Руководящие должности в рядовые не считаем: шеф-повар и су-шеф сильно сдвигают зарплату «повара»
SENIOR = ("шеф", "управляющ", "директор", "старший")
MONTHS = autopost.MONTHS


@dataclass
class Slide:
    """Один экран ролика: мелкая строка сверху, крупный заголовок, выделенная строка и подписи."""
    kicker: str = ""
    title: str = ""
    big: str = ""  # главное число или слово, жёлтым
    lines: list[str] = field(default_factory=list)
    seconds: float = SECONDS["item"]


@dataclass
class Clip:
    name: str  # имя файла без расширения
    slides: list[Slide]
    caption: str  # подпись к ролику в соцсети


def _plural(n: int, one: str, few: str, many: str) -> str:
    if n % 10 == 1 and n % 100 != 11:
        return one
    return few if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14 else many


def role_of(v: Vacancy) -> str | None:
    title = v.title.lower()
    if any(word in title for word in SENIOR):
        return None
    return next((role for role, (word, *_) in ROLES.items() if word in title), None)


def _monthly(v: Vacancy) -> tuple[int, int] | None:
    """Зарплата в пересчёте на месяц: (от, до). Смена считается за 22 дня, час — за 176 часов."""
    lo, hi = v.salary_min or v.salary_max, v.salary_max or v.salary_min
    if not lo or not hi or not v.salary_period:
        return None
    k = PER_MONTH[v.salary_period]
    return (lo * k, hi * k) if PAY_RANGE[0] <= lo * k and hi * k <= PAY_RANGE[1] else None


def _round(value: float, step: int = 10_000) -> int:
    return int(round(value / step) * step)


def _link() -> str:
    return launch.app_link(launch.start_param(source=SOURCE, city=CITY) or CITY)


def _outro() -> Slide:
    return Slide(kicker="vacante.kz", title="Откликнуться можно в одно нажатие", big="@vacantekz_bot",
                 lines=["Откройте в Telegram или по ссылке в профиле", "Бесплатно"], seconds=SECONDS["outro"])


def _tags(role: str) -> str:
    return f"#работаалматы #вакансииалматы #общепит #{role.lower()}"


def list_clip(role: str, items: list[Vacancy], now: datetime) -> Clip:
    """«5 вакансий повара в Алматы»: обложка, по слайду на вакансию, концовка."""
    local = now.astimezone(autopost.LOCAL)
    where = _locative(CITY)
    n = len(items)
    head = f"{n} {_plural(n, 'вакансия', 'вакансии', 'вакансий')} {ROLES[role][1]} в {where}"
    date = f"{local.day} {MONTHS[local.month - 1]}"
    slides = [Slide(kicker=f"vacante.kz · {date}", title=head, lines=["Свежие, с зарплатой"], seconds=SECONDS["intro"])]
    rows = []
    for i, v in enumerate(items, 1):
        facts = [f"График: {v.schedule}"] if v.schedule else []
        if v.perks:
            facts.append(" · ".join(v.perks[:3]))
        if v.address:
            facts.append(v.address)
        slides.append(Slide(kicker=f"{i} из {n} · {v.employer or 'Алматы'}", title=v.title, big=salary_label(v) or "",
                            lines=facts))
        rows.append(f"{i}. {v.title}" + (f" — {v.employer}" if v.employer else "") + f", {salary_label(v)}")
    slides.append(_outro())
    caption = "\n".join([f"{head} на {date} 👇", "", *rows, "",
                         f"Откликнуться в одно нажатие: {_link()}", "", _tags(role)])
    return Clip(f"{local.date().isoformat()}-{CITY}-vakansii-{ROLES[role][3]}", slides, caption)


def pay_clip(role: str, items: list[Vacancy], now: datetime) -> Clip | None:
    """«Сколько платят официанту в Алматы»: середина рынка по своей базе и верхняя четверть.
    Заведений не называем: в базе есть ИП с фамилией вместо названия."""
    pays = [(p, v) for v in items if (p := _monthly(v))]
    if len(pays) < STATS_MIN:
        return None
    local = now.astimezone(autopost.LOCAL)
    where = _locative(CITY)
    mids = sorted((lo + hi) / 2 for (lo, hi), _ in pays)
    q1, _, q3 = quantiles(mids, n=4)
    low, high = _round(q1), _round(q3)
    n = len(pays)
    counted = f"Посчитали по {n} {_plural(n, 'вакансии', 'вакансиям', 'вакансиям')} за две недели"
    question = f"Сколько платят {ROLES[role][2]} в {where}?"
    slides = [
        Slide(kicker="vacante.kz · зарплаты", title=question, lines=[counted], seconds=SECONDS["intro"]),
        Slide(kicker="Половина вакансий — в этих пределах", title="Обычно", big=f"{money(low)} – {money(high)} ₸",
              lines=["в месяц", "Оплату за смену пересчитали на 22 смены"], seconds=3.4),
    ]
    slides.append(Slide(kicker="А больше?", title="Каждая четвёртая вакансия", big=f"от {money(high)} ₸",
                        lines=["в месяц"], seconds=3.0))
    slides.append(_outro())
    caption = "\n".join([f"{question}", "",
                         f"Обычно {money(low)} – {money(high)} ₸ в месяц: в этих пределах половина вакансий. "
                         f"Каждая четвёртая — от {money(high)} ₸.",
                         f"{counted} на vacante.kz. Оплату за смену пересчитали на месяц (22 смены).", "",
                         f"Все вакансии и отклик в одно нажатие: {_link()}", "", _tags(role)])
    return Clip(f"{local.date().isoformat()}-{CITY}-zarplata-{ROLES[role][3]}", slides, caption)


def plan(reviewed: list[Vacancy], everything: list[Vacancy], now: datetime) -> list[Clip]:
    """Ролики на сегодня. reviewed — что можно показывать поимённо (проверено агентом или от работодателей),
    everything — вся база для подсчёта зарплат. Должность меняется по дням, у двух роликов она разная."""
    day = now.astimezone(autopost.LOCAL).date().toordinal()
    cutoff = (now - FRESH).isoformat()
    ours = lambda v: v.city == CITY and v.category == SPHERE and not v.shift_date  # noqa: E731
    by_role: dict[str, list[Vacancy]] = {}
    for v in sorted(reviewed, key=lambda v: v.posted_at, reverse=True):
        if ours(v) and v.posted_at >= cutoff and (role := role_of(v)) and salary_label(v):
            group = by_role.setdefault(role, [])
            if v.employer not in {x.employer for x in group if x.employer}:  # одно заведение — один слайд
                group.append(v)
    listable = [r for r in ROLES if len(by_role.get(r, [])) >= LIST_MIN]
    clips = []
    list_role = listable[day % len(listable)] if listable else None
    if list_role:
        clips.append(list_clip(list_role, by_role[list_role][:LIST_MAX], now))
    stats: dict[str, list[Vacancy]] = {}
    for v in everything:
        if ours(v) and (role := role_of(v)):
            stats.setdefault(role, []).append(v)
    payable = [r for r in ROLES if sum(1 for v in stats.get(r, []) if _monthly(v)) >= STATS_MIN]
    others = [r for r in payable if r != list_role] or payable
    if others and (clip := pay_clip(others[day % len(others)], stats[others[day % len(others)]], now)):
        clips.append(clip)
    return clips


# Отрисовка

def draw(slide: Slide) -> Image.Image:
    img = Image.new("RGB", (W, H), BRAND)
    d = ImageDraw.Draw(img)
    width = W - 2 * PAD
    d.text((PAD, 150), slide.kicker, font=_font("SemiBold", 48), fill=SOFT)
    blocks: list[tuple[list[str], object, str, int]] = []  # строки, шрифт, цвет, высота строки
    if slide.title:
        size = 112 if len(slide.title) <= 28 else 92
        blocks.append((_wrap(d, slide.title, _font("Bold", size), width, 4), _font("Bold", size), INK, int(size * 1.16)))
    if slide.big:
        size = next(s for s in (120, 104, 88, 72, 60) if d.textlength(slide.big, font=_font("Bold", s)) <= width or s == 60)
        blocks.append((_wrap(d, slide.big, _font("Bold", size), width, 2), _font("Bold", size), ACCENT, int(size * 1.2)))
    for line in slide.lines:
        blocks.append((_wrap(d, line, _font("SemiBold", 58), width, 2), _font("SemiBold", 58), SOFT, 76))
    gap = 44
    total = sum(len(lines) * h for lines, _, _, h in blocks) + gap * (len(blocks) - 1)
    y = max(300, (H - total) // 2)
    for lines, font, color, h in blocks:
        for line in lines:
            d.text((PAD, y), line, font=font, fill=color)
            y += h
        y += gap
    return img


def frames(slides: list[Slide], fps: int = FPS) -> Iterator[Image.Image]:
    """Кадры ролика: слайды сменяются плавно, сверху полоска «где мы сейчас», как в историях."""
    pictures = [draw(s) for s in slides]
    total = sum(s.seconds for s in slides)
    elapsed = 0.0
    seg_gap = 12
    seg_w = (W - 2 * PAD - seg_gap * (len(slides) - 1)) / len(slides)
    for i, (slide, picture) in enumerate(zip(slides, pictures)):
        count = round(slide.seconds * fps)
        for f in range(count):
            t = f / fps
            frame = picture if i == 0 or t >= FADE else Image.blend(pictures[i - 1], picture, t / FADE)
            frame = frame.copy()
            d = ImageDraw.Draw(frame)
            for k in range(len(slides)):
                x = PAD + k * (seg_w + seg_gap)
                d.rounded_rectangle((x, 84, x + seg_w, 94), radius=5, fill="#3d79ad")
                done = 1.0 if k < i else (t / slide.seconds if k == i else 0.0)
                if done:
                    d.rounded_rectangle((x, 84, x + max(10, seg_w * done), 94), radius=5, fill=INK)
            yield frame
        elapsed += slide.seconds
    assert abs(elapsed - total) < 1e-6


def ffmpeg_path() -> str | None:
    if path := shutil.which("ffmpeg"):
        return path
    try:
        import imageio_ffmpeg  # запасной вариант на компьютере без ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return None


def encode(slides: list[Slide], out: Path, ffmpeg: str) -> None:
    """mp4 (H.264, yuv420p, с тихой звуковой дорожкой: без неё часть площадок ролик не принимает)."""
    seconds = sum(s.seconds for s in slides)
    cmd = [ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
           "-r", str(FPS), "-i", "-", "-f", "lavfi", "-t", f"{seconds:.2f}", "-i", "anullsrc=r=44100:cl=stereo",
           "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k",
           "-shortest", "-movflags", "+faststart", str(out)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for frame in frames(slides):
            proc.stdin.write(frame.tobytes())
        proc.stdin.close()
    except BrokenPipeError:
        pass
    err = proc.stderr.read().decode("utf-8", "replace")
    if proc.wait() != 0:
        raise RuntimeError(f"ffmpeg: {err.strip()[-400:]}")


def render(clips: list[Clip], out: Path) -> list[Path]:
    """Пишет <имя>.mp4 и <имя>.txt (подпись) в папку out; возвращает готовые mp4."""
    ffmpeg = ffmpeg_path()
    if not ffmpeg:
        raise RuntimeError("нет ffmpeg: установите его или пакет imageio-ffmpeg")
    out.mkdir(parents=True, exist_ok=True)
    done = []
    for clip in clips:
        path = out / f"{clip.name}.mp4"
        encode(clip.slides, path, ffmpeg)
        (out / f"{clip.name}.txt").write_text(clip.caption + "\n", "utf-8")
        done.append(path)
    return done


CAPTION_LIMIT = 1024  # предел подписи к видео в Telegram
NOTE = ("🎬 <b>Ролики на сегодня</b> для Reels, TikTok и Shorts.\n"
        "Подпись под каждым — готовый текст для публикации. Ссылка из подписи помечена в воронке как «vid».")


def send(client: httpx.Client, token: str, chats: list[int], clips: list[Clip], out: Path) -> dict:
    """Отправляет готовые ролики с подписями в Telegram (модераторам): выкладывает их в соцсети человек."""
    api = f"https://api.telegram.org/bot{token}"
    stats = {"sent": 0, "failed": 0}
    for chat in chats:
        try:
            autopost._check(client.post(f"{api}/sendMessage", json={"chat_id": chat, "text": NOTE, "parse_mode": "HTML"}))
            for clip in clips:
                short = len(clip.caption) <= CAPTION_LIMIT
                autopost._check(client.post(
                    f"{api}/sendVideo",
                    data={"chat_id": chat, "supports_streaming": "true", "width": W, "height": H,
                          **({"caption": clip.caption} if short else {})},
                    files={"video": (f"{clip.name}.mp4", (out / f"{clip.name}.mp4").read_bytes(), "video/mp4")}))
                if not short:
                    autopost._check(client.post(f"{api}/sendMessage", json={"chat_id": chat, "text": clip.caption,
                                                                             "disable_web_page_preview": True}))
                stats["sent"] += 1
        except (httpx.HTTPError, RuntimeError) as exc:
            # В тексте сетевой ошибки адрес запроса с токеном: в лог только её вид
            log.warning("видео в чат модератора: %s", exc if isinstance(exc, RuntimeError) else type(exc).__name__)
            stats["failed"] += 1
    return stats

"""Картинки для Instagram vacante (vacante/instagram.py): обзор рынка, обложка Про-вакансий, сторис, советы
и пост для работодателей. Пост в ленте 1080×1350 (4:5), сторис 1080×1920. Текст на двух языках: русский
крупно, казахский под ним мельче. Карточка самой вакансии — vacante.card.slide.
"""

from __future__ import annotations

from io import BytesIO

from PIL import Image, ImageDraw

from vacante.card import BRAND, BRAND_SOFT, INK, QUIET, SLIDE_H, SLIDE_PAD, SLIDE_W, _font, _jpeg, _wrap

STORY_W, STORY_H = 1080, 1920
ACCENT = "#ffd43b"  # главное число, как в роликах vacante.video
BAR, BAR_BG = "#0a8ff0", "#e9f3fd"
X, WIDTH = SLIDE_PAD, SLIDE_W - 2 * SLIDE_PAD


def _header(d: ImageDraw.ImageDraw, label: str, page: str, dark: bool) -> None:
    d.text((X, SLIDE_PAD), "vacante.kz", font=_font("Bold", 44), fill="white" if dark else BRAND)
    right = " · ".join(p for p in (label, page) if p)
    if right:
        d.text((SLIDE_W - SLIDE_PAD, SLIDE_PAD + 6), right, font=_font("SemiBold", 34),
               fill=BRAND_SOFT if dark else "#adb5bd", anchor="ra")


def _text(d: ImageDraw.ImageDraw, y: int, text: str, size: int, color: str, weight: str = "Bold",
          lines: int = 3, step: float = 1.18, width: int = WIDTH) -> int:
    font = _font(weight, size)
    for line in _wrap(d, text, font, width, lines):
        d.text((X, y), line, font=font, fill=color)
        y += int(size * step)
    return y


def _footer(d: ImageDraw.ImageDraw, text: str, dark: bool) -> None:
    d.text((X, SLIDE_H - SLIDE_PAD), text, font=_font("Bold", 40), fill="white" if dark else BRAND, anchor="ls")


def title_slide(kicker: str, title_ru: str, title_kk: str, big: str = "", lines: list[str] | None = None,
                footer: str = "Листайте » · Парақтаңыз »", page: str = "") -> bytes:
    """Синяя карточка: обложка обзора, концовка с призывом, совет, пост для работодателей."""
    img = Image.new("RGB", (SLIDE_W, SLIDE_H), BRAND)
    d = ImageDraw.Draw(img)
    _header(d, kicker, page, dark=True)
    y = 250
    y = _text(d, y, title_ru, 96 if len(title_ru) <= 40 else 80, "white", lines=4)
    y = _text(d, y + 10, title_kk, 48, BRAND_SOFT, "SemiBold", lines=3) + 30
    if big:
        size = next(s for s in (150, 120, 96, 72) if d.textlength(big, font=_font("Bold", s)) <= WIDTH or s == 72)
        y = _text(d, y, big, size, ACCENT, lines=2, step=1.12) + 20
    for line in lines or []:
        if y > SLIDE_H - 260:
            break
        if line.startswith("· "):  # пункт списка: точка и текст
            d.ellipse((X, y + 20, X + 16, y + 36), fill=ACCENT)
            font = _font("SemiBold", 44)
            for part in _wrap(d, line[2:], font, WIDTH - 40, 2):
                d.text((X + 40, y), part, font=font, fill="white")
                y += 54
            y += 16
        else:
            y = _text(d, y, line, 42, BRAND_SOFT, "SemiBold", lines=3, step=1.25) + 14
    _footer(d, footer, dark=True)
    return _jpeg(img)


def bars_slide(kicker: str, title_ru: str, title_kk: str, rows: list[tuple[str, str, int, str]],
               note: str = "", page: str = "") -> bytes:
    """Белая карточка со списком и полосками: rows — (подпись по-русски, по-казахски, число для полоски, значение)."""
    img = Image.new("RGB", (SLIDE_W, SLIDE_H), "white")
    d = ImageDraw.Draw(img)
    _header(d, kicker, page, dark=False)
    y = _text(d, 200, title_ru, 72, INK, lines=2)
    y = _text(d, y + 4, title_kk, 40, QUIET, "SemiBold", lines=2) + 40
    top = max((r[2] for r in rows), default=0) or 1
    space = SLIDE_H - 230 - y
    step = min(170, space // max(1, len(rows)))
    label, sub, value = _font("Bold", 46), _font("Regular", 34), _font("Bold", 46)
    for ru, kk, amount, shown in rows:
        vw = d.textlength(shown, font=value)
        d.text((X, y), _wrap(d, ru, label, WIDTH - vw - 30, 1)[0], font=label, fill=INK)
        d.text((SLIDE_W - SLIDE_PAD, y), shown, font=value, fill=BRAND, anchor="ra")
        line = y + 58
        if kk and kk != ru:
            d.text((X, line), _wrap(d, kk, sub, WIDTH, 1)[0], font=sub, fill=QUIET)
            line += 44
        d.rounded_rectangle((X, line + 6, X + WIDTH, line + 26), radius=10, fill=BAR_BG)
        d.rounded_rectangle((X, line + 6, X + max(20, int(WIDTH * amount / top)), line + 26), radius=10, fill=BAR)
        y += step
    if note:
        d.text((X, SLIDE_H - SLIDE_PAD - 70), _wrap(d, note, _font("Regular", 32), WIDTH, 1)[0], font=_font("Regular", 32),
               fill=QUIET)
    _footer(d, "vacante.kz", dark=False)
    return _jpeg(img)


def story(slide_jpeg: bytes, top_ru: str, top_kk: str, bottom: str = "vacante.kz") -> bytes:
    """Сторис 1080×1920: карточка вакансии (4:5) посередине на синем фоне, надпись сверху и адрес снизу.
    Ссылку в сторис через API не поставить, поэтому адрес текстом."""
    img = Image.new("RGB", (STORY_W, STORY_H), BRAND)
    d = ImageDraw.Draw(img)
    with Image.open(BytesIO(slide_jpeg)) as pic:
        scale = 0.86
        pic = pic.convert("RGB").resize((int(SLIDE_W * scale), int(SLIDE_H * scale)), Image.LANCZOS)
    left, top = (STORY_W - pic.width) // 2, (STORY_H - pic.height) // 2 + 30
    mask = Image.new("L", pic.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, pic.width - 1, pic.height - 1), radius=40, fill=255)
    img.paste(pic, (left, top), mask)
    d.text((STORY_W // 2, 170), top_ru, font=_font("Bold", 64), fill="white", anchor="mm")
    d.text((STORY_W // 2, 245), top_kk, font=_font("SemiBold", 40), fill=BRAND_SOFT, anchor="mm")
    d.text((STORY_W // 2, STORY_H - 150), bottom, font=_font("Bold", 56), fill=ACCENT, anchor="mm")
    return _jpeg(img)

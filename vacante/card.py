"""Картинка к посту в Telegram, как в старых постах vacante: значок заведения,
должность, заведение, адрес и зарплата на белой карточке. Значок: аватар заведения из Instagram,
а если его нет, первая буква на цветном фоне.
"""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

from vacante.models import Vacancy
from vacante.site.build import city_name, salary_label

FONTS = Path(__file__).parent / "fonts"
WIDTH, PAD, LOGO, GAP = 1280, 64, 240, 56
TEXT_X = PAD + LOGO + GAP
TEXT_W = WIDTH - TEXT_X - PAD
INK, QUIET, PILL, PILL_INK = "#1d1d1f", "#6b6b70", "#e3f1fd", "#0b4f8a"
# Цвет значка по сфере, когда аватара заведения нет: первая буква на цветном фоне.
COLORS = {"horeca": "#e8590c", "retail": "#0a8ff0", "warehouse": "#7048e8", "delivery": "#2b8a3e",
          "service": "#0c8599", "construction": "#e67700", "callcenter": "#d6336c", "other": "#495057"}


def _font(weight: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / f"Inter-{weight}.otf"), size)


def _wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, width: int, max_lines: int) -> list[str]:
    """Разбивает текст на строки по ширине; не влезло — последняя строка с многоточием."""
    lines: list[str] = []
    words = text.split()
    while words and len(lines) < max_lines:
        line = words.pop(0)
        while words and draw.textlength(f"{line} {words[0]}", font=font) <= width:
            line += " " + words.pop(0)
        lines.append(line)
    if words or (lines and draw.textlength(lines[-1], font=font) > width):
        last = lines[-1]
        while last and draw.textlength(last + "…", font=font) > width:
            last = last[:-1]
        lines[-1] = last.rstrip(" ,.;–-") + "…"
    return lines


def _paste_avatar(img: Image.Image, avatar: bytes) -> bool:
    try:
        with Image.open(BytesIO(avatar)) as pic:
            pic = ImageOps.fit(pic.convert("RGB"), (LOGO, LOGO), Image.LANCZOS)
    except OSError:
        return False
    mask = Image.new("L", (LOGO, LOGO), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, LOGO - 1, LOGO - 1), radius=48, fill=255)
    img.paste(pic, (PAD, PAD), mask)
    return True


def render(v: Vacancy, avatar: bytes | None = None) -> bytes:
    """PNG-карточка вакансии для sendPhoto. avatar: JPEG аватара заведения, если он есть."""
    title_font, employer_font = _font("Bold", 64), _font("SemiBold", 46)
    address_font, salary_font = _font("Regular", 38), _font("SemiBold", 40)
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))

    blocks: list[tuple[list[str], ImageFont.FreeTypeFont, str, int]] = [
        (_wrap(probe, v.title, title_font, TEXT_W, 2), title_font, INK, 78),
    ]
    if v.employer:
        blocks.append((_wrap(probe, v.employer, employer_font, TEXT_W, 1), employer_font, INK, 60))
    place = city_name(v.city) + (f", {v.address}" if v.address else "")
    blocks.append((_wrap(probe, place, address_font, TEXT_W, 2), address_font, QUIET, 50))
    salary = salary_label(v)

    content = sum(len(lines) * step + 12 for lines, _, _, step in blocks) + (100 if salary else 0)
    height = max(PAD + LOGO, PAD + content) + PAD + 24
    img = Image.new("RGB", (WIDTH, height), "white")
    draw = ImageDraw.Draw(img)

    if not (avatar and _paste_avatar(img, avatar)):
        draw.rounded_rectangle((PAD, PAD, PAD + LOGO, PAD + LOGO), radius=48, fill=COLORS[v.category])
        letter = next((ch for ch in (v.employer or v.title) if ch.isalnum()), "V").upper()
        draw.text((PAD + LOGO / 2, PAD + LOGO / 2), letter, font=_font("Bold", 130), fill="white", anchor="mm")

    y = PAD - 6
    for lines, font, color, step in blocks:
        for line in lines:
            draw.text((TEXT_X, y), line, font=font, fill=color)
            y += step
        y += 12
    if salary:
        y += 8
        w = draw.textlength(salary, font=salary_font)
        draw.rounded_rectangle((TEXT_X, y, TEXT_X + w + 64, y + 76), radius=38, fill=PILL)
        draw.text((TEXT_X + 32, y + 38), salary, font=salary_font, fill=PILL_INK, anchor="lm")

    mark_font = _font("SemiBold", 30)
    draw.text((WIDTH - PAD, height - 36), "vacante.kz", font=mark_font, fill="#adb5bd", anchor="rs")

    out = BytesIO()
    img.save(out, "PNG", optimize=True)
    return out.getvalue()


# Подборка в Instagram: карусель 4:5 (1080×1350, JPEG — других форматов Instagram API не принимает).
# Первая карточка — обложка города со списком должностей, дальше по карточке на вакансию.

SLIDE_W, SLIDE_H, SLIDE_PAD = 1080, 1350, 84
BRAND, BRAND_SOFT = "#0b4f8a", "#9cc7ef"


def _jpeg(img: Image.Image) -> bytes:
    out = BytesIO()
    img.save(out, "JPEG", quality=90, optimize=True, progressive=True)
    return out.getvalue()


def _letter_logo(img: Image.Image, v: Vacancy, box: tuple[int, int], size: int) -> None:
    draw = ImageDraw.Draw(img)
    x, y = box
    draw.rounded_rectangle((x, y, x + size, y + size), radius=size // 5, fill=COLORS[v.category])
    letter = next((ch for ch in (v.employer or v.title) if ch.isalnum()), "V").upper()
    draw.text((x + size / 2, y + size / 2), letter, font=_font("Bold", int(size * 0.54)), fill="white", anchor="mm")


def _logo(img: Image.Image, v: Vacancy, avatar: bytes | None, box: tuple[int, int], size: int) -> None:
    if avatar:
        try:
            with Image.open(BytesIO(avatar)) as pic:
                pic = ImageOps.fit(pic.convert("RGB"), (size, size), Image.LANCZOS)
            mask = Image.new("L", (size, size), 0)
            ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=size // 5, fill=255)
            img.paste(pic, box, mask)
            return
        except OSError:
            pass
    _letter_logo(img, v, box, size)


def cover(where: str, items: list[Vacancy], date_label: str, channel: str | None = None) -> bytes:
    """Обложка подборки «Работа в Алматы» (where — город в предложном падеже): сколько вакансий и первые должности с зарплатой."""
    img = Image.new("RGB", (SLIDE_W, SLIDE_H), BRAND)
    draw = ImageDraw.Draw(img)
    x, width = SLIDE_PAD, SLIDE_W - 2 * SLIDE_PAD
    draw.text((x, SLIDE_PAD), "vacante.kz", font=_font("Bold", 44), fill="white")
    draw.text((SLIDE_W - SLIDE_PAD, SLIDE_PAD + 4), date_label, font=_font("SemiBold", 36), fill=BRAND_SOFT,
              anchor="ra")
    y = 250
    draw.text((x, y), "Работа", font=_font("Bold", 120), fill="white")
    y += 140
    for line in _wrap(draw, f"в {where}", _font("Bold", 120), width, 2):
        draw.text((x, y), line, font=_font("Bold", 120), fill="white")
        y += 140
    count = len(items)
    y += 20
    draw.text((x, y), f"Свежих вакансий: {count}", font=_font("SemiBold", 46), fill=BRAND_SOFT)
    y += 110
    row_font, pay_font = _font("SemiBold", 42), _font("Regular", 36)
    for v in items[:5]:
        draw.ellipse((x, y + 16, x + 16, y + 32), fill=BRAND_SOFT)
        draw.text((x + 40, y), _wrap(draw, v.title, row_font, width - 40, 1)[0], font=row_font, fill="white")
        y += 54
        if pay := salary_label(v):
            draw.text((x + 40, y), pay, font=pay_font, fill=BRAND_SOFT)
            y += 48
        y += 22
        if y > SLIDE_H - 300:
            break
    footer = "Листайте »"
    draw.text((x, SLIDE_H - SLIDE_PAD), footer, font=_font("Bold", 48), fill="white", anchor="ls")
    if channel:
        draw.text((SLIDE_W - SLIDE_PAD, SLIDE_H - SLIDE_PAD), f"Telegram {channel}", font=_font("SemiBold", 36),
                  fill=BRAND_SOFT, anchor="rs")
    return _jpeg(img)


def slide(v: Vacancy, avatar: bytes | None = None, page: str = "", channel: str | None = None) -> bytes:
    """Карточка вакансии в карусели: значок, должность, заведение, адрес, зарплата, график и условия."""
    # Содержимое рисуем отдельно и ставим по центру между верхом и подвалом карточки
    img = Image.new("RGB", (SLIDE_W, SLIDE_H), "white")
    draw = ImageDraw.Draw(img)
    x, width, logo = SLIDE_PAD, SLIDE_W - 2 * SLIDE_PAD, 220
    if page:
        draw.text((SLIDE_W - SLIDE_PAD, SLIDE_PAD), page, font=_font("SemiBold", 34), fill="#adb5bd", anchor="ra")
    footer_top = SLIDE_H - 150
    body = Image.new("RGB", (SLIDE_W, SLIDE_H), "white")
    img, canvas = body, img
    draw = ImageDraw.Draw(img)
    _logo(img, v, avatar, (x, 0), logo)
    y = logo + 64
    blocks = [(v.title, _font("Bold", 80), INK, 96, 3)]
    if v.employer:
        blocks.append((v.employer, _font("SemiBold", 52), INK, 66, 2))
    place = city_name(v.city) + (f", {v.address}" if v.address else "")
    blocks.append((place, _font("Regular", 42), QUIET, 56, 2))
    for text, font, color, step, lines in blocks:
        for line in _wrap(draw, text, font, width, lines):
            draw.text((x, y), line, font=font, fill=color)
            y += step
        y += 18
    if salary := salary_label(v):
        font = _font("SemiBold", 50)
        y += 10
        w = draw.textlength(salary, font=font)
        draw.rounded_rectangle((x, y, x + min(w + 72, width), y + 96), radius=48, fill=PILL)
        draw.text((x + 36, y + 48), salary, font=font, fill=PILL_INK, anchor="lm")
        y += 96 + 40
    facts = ([f"График: {v.schedule}"] if v.schedule else []) + list(v.perks[:4])
    limit = footer_top - 40 - (SLIDE_PAD + 40) - 58  # в координатах содержимого
    fact_font = _font("Regular", 40)
    for fact in facts:
        if y > limit:
            break
        if fact in v.perks:  # галочка рисуется: в шрифте Inter её нет
            draw.line((x + 4, y + 26, x + 14, y + 37, x + 34, y + 12), fill=PILL_INK, width=6, joint="curve")
        else:
            draw.ellipse((x + 10, y + 18, x + 26, y + 34), fill=PILL_INK)
        draw.text((x + 48, y), _wrap(draw, fact, fact_font, width - 48, 1)[0], font=fact_font, fill=INK)
        y += 58
    top = SLIDE_PAD + 40
    top += max(0, (footer_top - 40 - top - y) // 2)
    img, draw = canvas, ImageDraw.Draw(canvas)
    img.paste(body.crop((0, 0, SLIDE_W, y)), (0, top))
    draw.line((x, SLIDE_H - 150, SLIDE_W - SLIDE_PAD, SLIDE_H - 150), fill="#e9ecef", width=3)
    draw.text((x, SLIDE_H - SLIDE_PAD), "Откликнуться: vacante.kz", font=_font("Bold", 40), fill=BRAND, anchor="ls")
    if channel:
        draw.text((SLIDE_W - SLIDE_PAD, SLIDE_H - SLIDE_PAD), channel, font=_font("SemiBold", 34), fill=QUIET,
                  anchor="rs")
    return _jpeg(img)

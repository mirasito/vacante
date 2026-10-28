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

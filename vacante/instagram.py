"""Instagram vacante: что и когда публикуем (график в config/instagram.yaml, часы по Казахстану).

- «Обзор рынка» раз в день: карусель из своих данных — сколько новых вакансий за сутки, в каких городах
  и сферах, сколько платят по профессиям. Конкретных вакансий в обзоре нет.
- Вакансии только с тарифом «Про» (оплачены через бота, Vacancy.is_top): новая Про-вакансия выходит в ленту
  в ближайший час (несколько — одной каруселью) и в сторис, через неделю, если «Про» ещё действует, — ещё раз
  в ленту. Остальные вакансии в Instagram не попадают.
- Ролик (Reels) раз в день: «Сколько платят …» или «На что смотреть в объявлении» из vacante.video —
  ролики про зарплаты и признаки, без чужих вакансий.
- Совет соискателю и пост для работодателей по своим дням недели.

Как это работает каждый час (update.yml):
1. Сборка сайта (`plan`) кладёт картинки и ролик того, чему пора, в public/ig/ и план в public/ig/plan.json:
   Instagram забирает картинки и видео только по публичной ссылке, поэтому они на сайте.
2. После выкладки сайта `publish` публикует план через Instagram Graph API и записывает вышедшее в
   instagram.json ветки data.

Нужно: секрет INSTAGRAM_TOKEN (README, пункт 8а): токен входа через Instagram (начинается с IG, права
instagram_business_basic и instagram_business_content_publish, страница Facebook не нужна) или токен Facebook
с правом instagram_content_publish. Токен входа через Instagram живёт 60 дней; publish раз в неделю продлевает
его и хранит продлённый в базе бота (TokenStore), так что вставить его нужно один раз.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from collections import Counter
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import yaml

from vacante import autopost, card, igcards, review, venues
from vacante.localtime import LOCAL
from vacante.models import Vacancy
from vacante.parse import CATEGORIES
from vacante.site import i18n
from vacante.site.build import (PROFESSIONS, city_name, employer_prices, money, pay_stats, professions_of,
                                salary_label)
from vacante.store import load_vacancies

log = logging.getLogger(__name__)

CONFIG = Path("config/instagram.yaml")
STATE = "instagram.json"
PLAN = "ig/plan.json"
MAX_PRO = 9  # и обложка: в карусели не больше 10 карточек
CAPTION_LIMIT = 2200
DAY = timedelta(hours=24)
PAY_WINDOW = timedelta(days=14)  # зарплаты в обзоре — по вакансиям двух недель
PAY_MIN = 10  # меньше десяти вакансий с месячной зарплатой — профессию в обзор не берём
MONTHS = autopost.MONTHS
MONTHS_KK = ("қаңтар", "ақпан", "наурыз", "сәуір", "мамыр", "маусым", "шілде", "тамыз", "қыркүйек", "қазан",
             "қараша", "желтоқсан")
BOT = "@vacantekz_bot"
TAGS = "#вакансии #работа #работаказахстан #жұмыс #вакансиялар #vacantekz"
DAILY = ("review", "reel", "tips", "employers")  # раз в день в свой час


def load_config(path: Path = CONFIG) -> dict:
    raw = (yaml.safe_load(path.read_text("utf-8")) if path.exists() else None) or {}

    def at(name: str, hour: int, days: list[int] | None = None) -> dict:
        part = raw.get(name)
        if part is False:
            return {"hour": None, "weekdays": []}
        part = part or {}
        return {"hour": int(part.get("hour", hour)), "weekdays": list(part.get("weekdays", days or range(7)))}

    pro = raw.get("pro") or {}
    return {
        "daily_limit": int(raw.get("daily_limit", 40)),
        "pro": {"hours": list(pro.get("hours", range(9, 22))), "repost_days": int(pro.get("repost_days", 7)),
                "stories": bool(pro.get("stories", True))},
        "review": at("review", 10), "reel": at("reel", 18), "tips": at("tips", 15, [1, 3, 5]),
        "employers": at("employers", 12, [0, 4]),
    }


def load_state(data_dir: Path) -> dict:
    try:
        return json.loads((data_dir / STATE).read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(data_dir: Path, state: dict) -> None:
    (data_dir / STATE).write_text(json.dumps(state, ensure_ascii=False, indent=1) + "\n", "utf-8")


def slot(now: datetime) -> str:
    return now.astimezone(LOCAL).strftime("%Y-%m-%dT%H")


def today(now: datetime) -> str:
    return now.astimezone(LOCAL).date().isoformat()


def published_last_day(state: dict, now: datetime) -> int:
    cutoff = (now - DAY).isoformat()
    return sum(1 for p in state.get("log", []) if p["at"] >= cutoff)


def daily_due(kind: str, config: dict, state: dict, now: datetime) -> bool:
    """Пост раз в день: с его часа и до 21:00, если сегодня его ещё не было (пропущенный запуск догоняем)."""
    local = now.astimezone(LOCAL)
    rule = config[kind]
    return (rule["hour"] is not None and local.weekday() in rule["weekdays"] and rule["hour"] <= local.hour <= 21
            and state.get("done", {}).get(kind) != today(now))


# Про-вакансии

def pro_due(vacancies: list[Vacancy], state: dict, now: datetime, repost_days: int = 7) -> tuple[list[Vacancy], set[str]]:
    """Про-вакансии, которым пора в ленту: ещё ни разу не выходили или вышли один раз не меньше недели назад,
    а «Про» ещё действует. Второе — id новых (им ещё и сторис). Сначала новые, потом свежие."""
    shown = state.get("pro", {})
    fresh, again = [], []
    for v in sorted(vacancies, key=lambda v: v.posted_at, reverse=True):
        if not v.is_top(now) or (v.shift_date and v.shift_date < today(now)):
            continue
        times = shown.get(v.id, [])
        if not times:
            fresh.append(v)
        elif len(times) == 1 and times[0] <= (now - timedelta(days=repost_days)).isoformat():
            again.append(v)
    picked = (fresh + again)[:MAX_PRO]
    return picked, {v.id for v in fresh if v in picked}


def where(v: Vacancy) -> str:
    return city_name(v.city) if v.city else "Казахстан"


def pro_caption(items: list[Vacancy]) -> str:
    head = "Вакансия от работодателя на vacante.kz" if len(items) == 1 else "Вакансии от работодателей на vacante.kz"
    lines = [f"🔥 {head}", ""]
    for i, v in enumerate(items, 1):
        line = (f"{i}. " if len(items) > 1 else "") + f"{v.title}"
        if v.employer:
            line += f" — {v.employer}"
        line += f", {where(v)}"
        if pay := salary_label(v):
            line += f" · {pay}"
        lines.append(line)
    lines += ["", f"Откликнуться: vacante.kz (ссылка в профиле) или в Telegram {BOT}.",
              f"Жауап беру: vacante.kz (сілтеме профильде) немесе Telegram-да {BOT}."]
    cities = sorted({v.city for v in items if v.city})
    tags = [_hashtag(f"работа{city_name(c)}") for c in cities] + [_hashtag(f"вакансии{city_name(c)}") for c in cities]
    lines += ["", " ".join(tags + [TAGS])]
    return _fit(lines)


def _hashtag(text: str) -> str:
    return "#" + "".join(ch for ch in text.lower() if ch.isalnum())


def _fit(lines: list[str]) -> str:
    return "\n".join(lines)[:CAPTION_LIMIT]


def pro_cover(items: list[Vacancy], date_label: str) -> bytes:
    rows = [f"· {v.title}, {where(v)}" for v in items[:6]]
    return igcards.title_slide(f"PRO · {date_label}", "Вакансии от работодателей", "Жұмыс берушілерден вакансиялар",
                               big=str(len(items)), lines=rows)


# Обзор рынка

def market(vacancies: list[Vacancy], now: datetime) -> dict:
    """Числа для обзора: новые за сутки (всего, по городам и сферам), доля с зарплатой, сколько всего на сайте,
    медиана месячной зарплаты по самым частым профессиям за две недели."""
    day_cut, pay_cut = (now - DAY).isoformat(), (now - PAY_WINDOW).isoformat()
    day = [v for v in vacancies if v.posted_at >= day_cut and not v.shift_date]
    cities = Counter(v.city for v in day if v.city).most_common(5)
    spheres = Counter(v.category for v in day if v.category != "other").most_common(5)
    groups: dict[str, list[Vacancy]] = {}
    for v in vacancies:
        if v.posted_at >= pay_cut:
            for slug in professions_of(v):
                groups.setdefault(slug, []).append(v)
    pays = []
    for slug, items in groups.items():
        stats = pay_stats(items)
        if stats and stats[0] >= PAY_MIN:
            pays.append((PROFESSIONS[slug], stats[0], stats[1]))
    pays.sort(key=lambda p: -p[1])
    with_pay = sum(1 for v in day if v.salary_min or v.salary_max)
    return {"new": len(day), "total": len(vacancies), "cities": cities, "spheres": spheres,
            "pays": [(name, median) for name, _, median in pays[:5]],
            "with_pay": round(100 * with_pay / len(day)) if day else 0,
            "shifts": sum(1 for v in vacancies if v.shift_date and v.shift_date >= today(now))}


def _change(new: int, before: dict | None, now: datetime) -> tuple[str, str] | None:
    """«+12% к вчера» по сохранённому вчерашнему числу; нет вчерашнего — ничего."""
    yesterday = (now.astimezone(LOCAL).date() - timedelta(days=1)).isoformat()
    if not before or before.get("date") != yesterday or not before.get("new"):
        return None
    pct = round(100 * (new - before["new"]) / before["new"])
    sign = "+" if pct > 0 else ""
    return f"{sign}{pct}% к вчера", f"кешемен салыстырғанда {sign}{pct}%"


def review_cards(m: dict, now: datetime, before: dict | None = None) -> tuple[list[bytes], str]:
    local = now.astimezone(LOCAL)
    date_ru, date_kk = f"{local.day} {MONTHS[local.month - 1]}", f"{local.day} {MONTHS_KK[local.month - 1]}"
    kicker = f"Обзор рынка · {date_ru}"
    change = _change(m["new"], before, now)
    lines = ["новых вакансий за сутки · тәулікте жаңа вакансия"]
    if change:
        lines.append(f"{change[0]} · {change[1]}")
    lines.append(f"С зарплатой: {m['with_pay']}% · Жалақысы бар: {m['with_pay']}%")
    lines.append(f"Всего на сайте · Барлығы: {money(m['total'])}")
    images = [igcards.title_slide(kicker, "Рынок работы за сутки", f"Еңбек нарығы, {date_kk}", big=money(m["new"]),
                                  lines=lines)]
    if m["cities"]:
        rows = [(city_name(c), i18n.CITIES_KK.get(c, ""), n, money(n)) for c, n in m["cities"]]
        images.append(igcards.bars_slide(kicker, "Где больше новых вакансий", "Жаңа вакансия көп қалалар", rows,
                                         "Новые вакансии за сутки · Тәуліктегі жаңа вакансиялар"))
    if m["spheres"]:
        rows = [(CATEGORIES[c], i18n.CATEGORIES_KK.get(c, ""), n, money(n)) for c, n in m["spheres"]]
        images.append(igcards.bars_slide(kicker, "Кого ищут", "Кімді іздейді", rows,
                                         "Новые вакансии за сутки по сферам · Салалар бойынша"))
    if m["pays"]:
        rows = [(name, i18n.TITLES_KK.get(name, ""), pay, f"{money(pay)} ₸") for name, pay in m["pays"]]
        images.append(igcards.bars_slide(kicker, "Сколько платят в месяц", "Айына қанша төлейді", rows,
                                         "Медиана по вакансиям за 2 недели · 2 аптадағы медиана"))
    images.append(igcards.title_slide(
        "vacante.kz", "Работа рядом с домом", "Үйге жақын жұмыс",
        lines=["· Все вакансии бесплатно: vacante.kz", f"· В Telegram: {BOT}", "· Барлық вакансиялар тегін",
               "Работодателям: вакансия «Про» выходит в нашем Instagram"],
        footer="Ссылка в профиле · Сілтеме профильде"))
    text = [f"Рынок работы на {date_ru}: {money(m['new'])} новых вакансий за сутки"
            + (f" ({change[0]})." if change else "."), ""]
    if m["cities"]:
        text.append("Больше всего — " + ", ".join(f"{city_name(c)} {money(n)}" for c, n in m["cities"][:3]) + ".")
    if m["spheres"]:
        text.append("Чаще ищут: " + ", ".join(CATEGORIES[c].lower() for c, _ in m["spheres"][:3]) + ".")
    if m["pays"]:
        text.append("Обычная зарплата в месяц: " + ", ".join(f"{n.lower()} {money(p)} ₸" for n, p in m["pays"][:3]) + ".")
    text += ["", f"{date_kk}: тәулікте {money(m['new'])} жаңа вакансия. Барлық вакансиялар — vacante.kz.", "",
             f"Все вакансии и отклик в одно нажатие: vacante.kz (ссылка в профиле) и {BOT}.", "",
             "#рыноктруда #зарплаты #работаалматы #работаастана " + TAGS]
    return images, _fit(text)


# Советы и пост для работодателей

TIPS = [
    ("Спросите сумму до собеседования", "Жалақыны әңгімелесуге дейін сұраңыз",
     ["· За смену или в месяц?", "· Когда платят и как: на карту или наличными", "· Есть ли штрафы и удержания"],
     ["Ауысым үшін бе, айына ма? Қашан және қалай төлейді?"]),
    ("Стажировка: что уточнить", "Тағылымдама: не нақтылау керек",
     ["· Сколько дней она длится", "· Платят ли за дни стажировки", "· Что будет после неё"],
     ["Неше күн? Төлене ме? Кейін не болады?"]),
    ("Просят залог? Осторожно", "Кепілақы сұрай ма? Абай болыңыз",
     ["· Нормальный работодатель не берёт деньги за форму и обучение", "· Узнайте, за что и когда вернут",
      "· Не платите до первого рабочего дня"],
     ["Жұмыс беруші форма мен оқыту үшін ақша алмайды"]),
    ("Как откликнуться, чтобы ответили", "Жауап алу үшін қалай жазу керек",
     ["· Имя, возраст и опыт в одном сообщении", "· Когда можете выйти", "· Фото в профиле vacante"],
     ["Аты-жөні, жасы, тәжірибесі — бір хабарламада"]),
    ("Работа рядом с домом", "Үйге жақын жұмыс",
     ["· Укажите адрес в профиле vacante", "· Покажем, сколько ехать до работы", "· Дорога дешевле и короче"],
     ["Профильде мекенжайды көрсетіңіз — жолды есептейміз"]),
    ("Подработка на день", "Бір күндік қосымша жұмыс",
     ["· Смены с оплатой в тот же день", "· Раздел «Подработка и смены» на vacante.kz", "· Беру смену — одна кнопка"],
     ["Ауысымдар бөлімі: vacante.kz"]),
    ("Первый день на новом месте", "Жаңа жердегі бірінші күн",
     ["· Приходите на 10 минут раньше", "· Возьмите удостоверение", "· Запишите имя старшего смены"],
     ["10 минут ерте келіңіз, жеке куәлігіңізді алыңыз"]),
    ("Официально или нет?", "Ресми ме, жоқ па?",
     ["· Официальная работа — это пенсионные отчисления и больничный", "· Спросите про трудовой договор",
      "· В вакансиях vacante есть пометка «Официально»"],
     ["Ресми жұмыс — зейнетақы аударымдары мен ауруханалық"]),
]


def tip_card(n: int) -> tuple[bytes, str]:
    ru, kk, points, kk_lines = TIPS[n % len(TIPS)]
    image = igcards.title_slide("Совет · Кеңес", ru, kk, lines=points + kk_lines, footer="vacante.kz")
    caption = [f"{ru}.", "", *[p[2:] + "." for p in points], "", f"{kk}. {' '.join(kk_lines)}", "",
               f"Все вакансии: vacante.kz (ссылка в профиле) и {BOT}.", "", "#поискработы #советы " + TAGS]
    return image, _fit(caption)


def employers_card() -> tuple[bytes, str] | None:
    prices = employer_prices()
    if not prices:
        return None
    pro, basic, days = money(prices["pro"]), money(prices["post"]), prices["days"]
    image = igcards.title_slide(
        "Работодателям · Жұмыс берушілерге", "Ищете сотрудников?", "Қызметкер іздейсіз бе?",
        big=f"от {basic} ₸",
        lines=[f"· Базовый {basic} ₸: сайт, приложение, канал города", f"· Про {pro} ₸: первые {days} дней и пост в Instagram", "· Отклики приходят в Telegram", f"Разместить: {BOT}"],
        footer=f"Telegram {BOT}")
    caption = [f"Ищете сотрудников? Разместите вакансию на vacante.kz от {basic} ₸.", "",
               f"Базовый, {basic} ₸: сайт и приложение на 30 дней, подборки соискателям, пост в Telegram-канале города.",
               f"Про, {pro} ₸: всё из Базового, первое место в списке города {days} дней, закреп в канале и пост "
               "в этом Instagram.", "Отклики кандидатов приходят прямо в Telegram.", "",
               f"Қызметкер іздейсіз бе? Вакансияны {BOT} арқылы орналастырыңыз, {basic} ₸ бастап.", "",
               f"Разместить: {BOT} → «Ищу сотрудников» или vacante.kz/rabotodatelyam/", "",
               "#работодателям #поисксотрудников #hr #бизнесказахстан #vacantekz"]
    return image, _fit(caption)


# План на этот час

def plan(data_dir: Path, out: Path, base_url: str, now: datetime | None = None, config: dict | None = None,
         reel: Callable[[list[Vacancy], list[Vacancy], datetime, Path], tuple[Path, str] | None] | None = None) -> list[dict]:
    """Картинки и план на этот час: public/ig/<дата-час>/… и public/ig/plan.json."""
    now = now or datetime.now(timezone.utc)
    config = config or load_config()
    base_url = base_url.rstrip("/")
    state = load_state(data_dir)
    held = autopost.awaiting_review(data_dir)
    original = {v.id: v for v in load_vacancies(data_dir) if v.id not in held}
    reviews = review.load(data_dir) or {}
    vacancies = [review.reviewed(v, reviews.get(i)) for i, v in original.items()]
    local = now.astimezone(LOCAL)
    folder = f"ig/{local:%Y%m%d%H}"
    room = config["daily_limit"] - published_last_day(state, now)
    result: list[dict] = []

    def save(name: str, data: bytes) -> str:
        (out / folder).mkdir(parents=True, exist_ok=True)
        (out / folder / name).write_bytes(data)
        return f"{base_url}/{folder}/{name}"

    def add(post: dict) -> None:
        nonlocal room
        if room > 0:
            result.append({"slot": slot(now), **post})
            room -= 1

    if daily_due("review", config, state, now):
        m = market(vacancies, now)
        if m["new"]:
            images, text = review_cards(m, now, state.get("review"))
            add({"kind": "review", "type": "carousel", "caption": text, "new": m["new"],
                 "images": [save(f"review-{n}.jpg", img) for n, img in enumerate(images, 1)]})

    if local.hour in config["pro"]["hours"] and state.get("pro_slot") != slot(now):
        items, fresh = pro_due(vacancies, state, now, config["pro"]["repost_days"])
        table = venues.load(data_dir)
        if items:
            total = len(items) + (1 if len(items) > 1 else 0)
            avatars = {v.id: venues.avatar_bytes(data_dir, venues.lookup(table, original[v.id])) for v in items}
            first = total - len(items) + 1
            images = [save(f"pro-{n}.jpg", card.slide(v, avatars[v.id], f"{n}/{total}" if total > 1 else ""))
                      for n, v in enumerate(items, first)]
            if len(items) > 1:
                images.insert(0, save("pro-cover.jpg", pro_cover(items, f"{local.day} {MONTHS[local.month - 1]}")))
            add({"kind": "pro", "type": "carousel" if len(images) > 1 else "image", "images": images,
                 "caption": pro_caption(items), "ids": [v.id for v in items]})
            if config["pro"]["stories"]:
                for n, v in enumerate(items, 1):
                    if v.id in fresh:
                        story = igcards.story(card.slide(v, avatars[v.id]), "Новая вакансия", "Жаңа вакансия")
                        add({"kind": "story", "type": "story", "images": [save(f"story-{n}.jpg", story)],
                             "ids": [v.id]})

    if daily_due("tips", config, state, now):
        n = int(state.get("tips_n", 0))
        image, text = tip_card(n)
        add({"kind": "tips", "type": "image", "images": [save("tip.jpg", image)], "caption": text, "n": n})

    if daily_due("employers", config, state, now) and (made := employers_card()):
        add({"kind": "employers", "type": "image", "images": [save("employers.jpg", made[0])], "caption": made[1]})

    if reel and daily_due("reel", config, state, now):
        everything = list(original.values())
        checked = autopost.checked_by_agent(everything, reviews)
        (out / folder).mkdir(parents=True, exist_ok=True)
        if made := reel(checked, everything, now, out / folder):
            path, text = made
            add({"kind": "reel", "type": "reel", "video": f"{base_url}/{folder}/{path.name}", "caption": text})

    (out / "ig").mkdir(parents=True, exist_ok=True)
    payload = {"created_at": now.isoformat(timespec="seconds"), "posts": result}
    (out / PLAN).write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", "utf-8")
    return result


def make_reel(checked: list[Vacancy], everything: list[Vacancy], now: datetime, out: Path) -> tuple[Path, str] | None:
    """Ролик дня из vacante.video: про зарплаты или признаки в объявлениях, по дням по очереди. Ролик-список
    вакансий не берём: в Instagram выходят только Про-вакансии."""
    from vacante import video

    if not video.ffmpeg_path():
        log.info("instagram: нет ffmpeg, ролик пропускаю")
        return None
    clips = [c for c in video.plan(checked, everything, now) if "-vakansii-" not in c.name]
    if not clips:
        return None
    clip = clips[now.astimezone(LOCAL).date().toordinal() % len(clips)]
    path = out / f"reel-{clip.name}.mp4"
    video.encode(clip.slides, path, video.ffmpeg_path())
    text = clip.caption + "\n\nБарлық вакансиялар: vacante.kz · " + BOT
    return path, _fit(text.splitlines())


# Публикация

class PublishError(RuntimeError):
    pass


class Publisher:
    """Публикация через Instagram Graph API (content publishing): фото, карусель, сторис, ролик."""

    def __init__(self, api: venues.InstagramAPI, sleep: Callable[[float], None] = time.sleep):
        self.api, self.sleep = api, sleep

    def _post(self, path: str, **params) -> dict:
        r = self.api.client.post(f"{self.api.base}/{path}", data={**params, "access_token": self.api.token})
        body = r.json() if r.headers.get("content-type", "").startswith(("application/json", "text/javascript")) else {}
        if r.status_code != 200:
            error = body.get("error", {})
            message = (f"Instagram API {r.status_code}: {error.get('message', r.reason_phrase)}"
                       f" (code {error.get('code')}, subcode {error.get('error_subcode')})")
            raise (venues.TokenError if error.get("code") in (102, 190) else PublishError)(message)
        return body

    def can_publish(self) -> str | None:
        """None, если можно публиковать, иначе почему нельзя."""
        try:
            self.api.user_id()
        except RuntimeError as exc:
            return str(exc)
        if self.api.instagram_login:
            return None  # debug_token у graph.instagram.com нет; без права публикации ответит сам API
        scopes = self.api._debug().get("scopes")
        if scopes is not None and "instagram_content_publish" not in scopes:
            return "у токена нет права instagram_content_publish: выберите его при создании токена"
        return None

    def quota_left(self) -> int | None:
        try:
            body = self.api._get(f"{self.api.user_id()}/content_publishing_limit", fields="quota_usage,config")
        except RuntimeError:
            return None
        data = (body.get("data") or [{}])[0]
        total = (data.get("config") or {}).get("quota_total")
        return None if total is None else total - int(data.get("quota_usage") or 0)

    def _wait(self, container: str, tries: int = 10, pause: float = 6) -> None:
        for _ in range(tries):
            status = self.api._get(container, fields="status_code").get("status_code")
            if status == "FINISHED":
                return
            if status in ("ERROR", "EXPIRED"):
                raise PublishError(f"контейнер {status}")
            self.sleep(pause)
        raise PublishError(f"контейнер не готов за {int(tries * pause)} с")

    def _publish(self, container: str, tries: int = 10, pause: float = 6) -> str:
        self._wait(container, tries, pause)
        return self._post(f"{self.api.user_id()}/media_publish", creation_id=container)["id"]

    def carousel(self, images: list[str], text: str) -> str:
        """id опубликованного поста."""
        ig = self.api.user_id()
        children = [self._post(f"{ig}/media", image_url=url, is_carousel_item="true")["id"] for url in images]
        for child in children:
            self._wait(child)
        container = self._post(f"{ig}/media", media_type="CAROUSEL", children=",".join(children), caption=text)["id"]
        return self._publish(container)

    def image(self, url: str, text: str) -> str:
        return self._publish(self._post(f"{self.api.user_id()}/media", image_url=url, caption=text)["id"])

    def story(self, url: str) -> str:
        return self._publish(self._post(f"{self.api.user_id()}/media", image_url=url, media_type="STORIES")["id"])

    def reel(self, url: str, text: str) -> str:
        """Ролик обрабатывается дольше картинки: ждём до пяти минут."""
        container = self._post(f"{self.api.user_id()}/media", media_type="REELS", video_url=url, caption=text,
                               share_to_feed="true")["id"]
        return self._publish(container, tries=30, pause=10)

    def send(self, post: dict) -> str:
        kind = post["type"]
        if kind == "carousel":
            return self.carousel(post["images"], post["caption"])
        if kind == "image":
            return self.image(post["images"][0], post["caption"])
        if kind == "story":
            return self.story(post["images"][0])
        if kind == "reel":
            return self.reel(post["video"], post["caption"])
        raise PublishError(f"неизвестный вид поста {kind}")


def mark(state: dict, post: dict, media: str, now: datetime) -> None:
    """Записывает вышедший пост: что уже было сегодня, какие Про-вакансии и когда показаны, журнал за неделю."""
    kind, at = post["kind"], now.isoformat(timespec="seconds")
    if kind in DAILY:
        state.setdefault("done", {})[kind] = today(now)
    if kind == "review":
        state["review"] = {"date": today(now), "new": post.get("new", 0)}
    if kind == "tips":
        state["tips_n"] = int(post.get("n", 0)) + 1
    if kind == "pro":
        state["pro_slot"] = post["slot"]
        shown = state.setdefault("pro", {})
        for vid in post["ids"]:
            shown.setdefault(vid, []).append(at)
        old = (now - timedelta(days=60)).isoformat()
        state["pro"] = {k: v for k, v in shown.items() if v and v[-1] >= old}
    state["log"] = [e for e in state.get("log", []) if e["at"] >= (now - timedelta(days=7)).isoformat()]
    state["log"].append({"at": at, "kind": kind, "media": media})


def publish(data_dir: Path, posts: list[dict], publisher: Publisher, now: datetime | None = None,
            config: dict | None = None) -> list[tuple[str, str]]:
    """Публикует план и записывает вышедшее в instagram.json. Отчёт для аннотации."""
    now = now or datetime.now(timezone.utc)
    config = config or load_config()
    if not posts:
        return [("instagram", "на этот час ничего нет")]
    if reason := publisher.can_publish():
        return [("instagram", f"error: {reason}")]
    state = load_state(data_dir)
    left = publisher.quota_left()
    room = config["daily_limit"] - published_last_day(state, now)
    report = []
    for p in posts:
        kind = p["kind"]
        if (kind in DAILY and state.get("done", {}).get(kind) == today(now)) or \
                (kind == "pro" and state.get("pro_slot") == p["slot"]):
            report.append((kind, "уже опубликовано"))
            continue
        if room <= 0 or (left is not None and left <= 0):
            report.append((kind, "пропущено: дневной лимит публикаций"))
            continue
        try:
            media = publisher.send(p)
        except venues.TokenError:
            raise
        except (RuntimeError, KeyError) as exc:
            report.append((kind, f"error: {exc}"))
            continue
        except Exception as exc:  # сеть: остальное попробуем
            report.append((kind, f"error: {type(exc).__name__}"))
            continue
        mark(state, p, media, now)
        save_state(data_dir, state)  # после каждого поста: следующий может упасть
        room -= 1
        if left is not None:
            left -= 1
        report.append((kind, f"опубликовано (пост {media})"))
    return report


# Токен

REFRESH_EVERY = timedelta(days=7)
REFRESH_URL = "https://graph.instagram.com/refresh_access_token"


def refresh_token(client: httpx.Client, token: str) -> str | None:
    """Продлённый на 60 дней токен входа через Instagram, или None (токену меньше суток или он уже не работает)."""
    try:
        r = client.get(REFRESH_URL, params={"grant_type": "ig_refresh_token", "access_token": token})
    except httpx.HTTPError:
        return None
    return r.json().get("access_token") if r.status_code == 200 else None


class TokenStore:
    """Токен Instagram в базе бота (D1): секрет INSTAGRAM_TOKEN — только первый токен, дальше publish раз в неделю
    продлевает его и хранит здесь. Новый секрет (сгенерировали заново) заменяет сохранённый: по отпечатку секрета."""

    TABLE = ("CREATE TABLE IF NOT EXISTS instagram_token (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, "
             "seed TEXT NOT NULL, refreshed_at TEXT NOT NULL)")

    def __init__(self, d1):
        self.d1 = d1

    def token(self, secret: str, refresh: Callable[[str], str | None], now: datetime | None = None) -> str:
        now = now or datetime.now(timezone.utc)
        seed = hashlib.sha256(secret.encode()).hexdigest()[:16]
        self.d1.query(self.TABLE)
        rows = self.d1.query("SELECT token, seed, refreshed_at FROM instagram_token WHERE id = 1")
        row = rows[0] if rows and rows[0]["seed"] == seed else None
        token = row["token"] if row else secret
        if not token.startswith("IG"):
            return token  # токен Facebook не продлевается так; долгий токен страницы и не истекает
        if row and row["refreshed_at"] >= (now - REFRESH_EVERY).isoformat():
            return token
        if fresh := refresh(token):
            self.d1.query("INSERT OR REPLACE INTO instagram_token (id, token, seed, refreshed_at) VALUES (1, ?, ?, ?)",
                          [fresh, seed, now.isoformat(timespec="seconds")])
            return fresh
        return token

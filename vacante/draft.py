"""Черновик поста «не вакансия» для канала Алматы: каждый день один, из собственной базы вакансий.

Три темы по очереди, все про общепит Алматы за последние семь дней:
- «Сколько платят бариста в Алматы на этой неделе»: середина и разброс зарплат по одной должности;
- «Кто нанимает»: заведение, которое выложило несколько вакансий, что оно ищет и за сколько;
- совет по отклику, который держится на цифре из базы, а не на общих словах.

В канал код ничего не публикует: черновик и справка «на чём посчитано» приходят модераторам в Telegram
(тем же, кому уходят ролики, vacante/video.py), а читает, правит и публикует человек. Ссылка в конце поста
ведёт в мини-приложение с меткой источника «tgnv»: воронка показывает, сколько людей пришло с таких постов.

Цифра попадает в пост, только если под ней достаточно вакансий (пороги ниже). Не хватает на тему — берётся
следующая, не хватает ни на одну — черновика нет, модераторам уходит короткое сообщение. Что уже отправляли,
хранится в drafts.json рядом с вакансиями: тема и должность (заведение, совет) два дня подряд не повторяются.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from statistics import median, quantiles

import httpx

from vacante import autopost, contacts, launch, review, tg, venues
from vacante.localtime import LOCAL
from vacante.models import Vacancy
from vacante.site.build import _locative, money, salary_label
from vacante.video import CITY, PAY_RANGE, ROLES, SPHERE, _plural, _round, role_of

log = logging.getLogger(__name__)

SOURCE = "tgnv"  # метка источника в ссылке из поста: «tg, не вакансия»
WINDOW = timedelta(days=7)
# Середина и четверти по должности: при восьми вакансиях на каждую четверть приходится по две, одна необычная
# вакансия середину не сдвигает. Меньше — цифра зависит от одной вакансии, больше (15) — за неделю остаются
# только повар и официант, и должности пришлось бы повторять
PAY_MIN = 8
# Доля («4 из 10») — от 30 вакансий: одна вакансия сдвигает её не больше чем на 3 процентных пункта
SHARE_MIN = 30
# «Несколько вакансий» заведения — хотя бы две разные с указанной суммой по одному адресу
VENUE_MIN, VENUE_MAX = 2, 5
VENUE_GAP = timedelta(days=7)  # одно заведение — не чаще раза в неделю
THEMES = ("pay", "venue", "tip")
THEME_NAMES = {"pay": "зарплаты по должности", "venue": "заведение, которое нанимает", "tip": "совет по отклику"}
STATE = "drafts.json"
KEEP = 30  # сколько отправленных черновиков помнить
# Суммы вне этих пределов — опечатка или не зарплата. За месяц — как в роликах, за смену и час — как у агента
LIMITS = {"month": PAY_RANGE, "day": review.PERIODS["day"], "hour": review.PERIODS["hour"]}
STEP = {"month": 10_000, "day": 1_000, "hour": 100}  # до чего округляем середину и четверти
PER = {"month": "в месяц", "day": "за смену", "hour": "в час"}
FOR = {"month": "за месяц", "day": "за смену", "hour": "за час"}
# ИП с фамилией вместо названия заведения: в пост такое имя не идёт
PERSON = re.compile(r"\b[А-ЯЁA-Z]\.\s?[А-ЯЁA-Z]\b|\s[А-ЯЁ]\s[А-ЯЁ]\b|^\s*(?:ИП|Ип|ип)\s")
# «Повар горячего цеха в ресторан Plateau 1966» → «Повар горячего цеха»: заведение уже названо в заголовке
TAIL = re.compile(r"[\s,]+(?:в|на|для)\s+(?:нов\w+\s+|наш\w+\s+)?(?:ресторан|кафе|кофейн|бар|сеть|столов)\w*\b.*$", re.I)


@dataclass
class Draft:
    theme: str  # pay | venue | tip
    key: str  # должность, заведение или вид совета: по нему не повторяемся
    text: str  # готовый пост для канала
    basis: str  # справка для человека: на чём посчитано


def _vacancies(n: int, case: str = "nom") -> str:
    forms = {"nom": ("вакансия", "вакансии", "вакансий"), "acc": ("вакансию", "вакансии", "вакансий"),
             "gen": ("вакансии", "вакансий", "вакансий"), "dat": ("вакансии", "вакансиям", "вакансиям")}[case]
    return f"{n} {_plural(n, *forms)}"


def _link(vacancy_id: str | None = None) -> str:
    param = vacancy_id and launch.start_param(source=SOURCE, city=CITY, vacancy_id=vacancy_id)
    return launch.app_link(param or launch.start_param(source=SOURCE, city=CITY) or CITY)


def _days(now: datetime) -> str:
    """«9–16 ноября»: за какие дни посчитано."""
    end = now.astimezone(LOCAL)
    start = end - WINDOW
    if start.month == end.month:
        return f"{start.day}–{end.day} {autopost.MONTHS[end.month - 1]}"
    return f"{start.day} {autopost.MONTHS[start.month - 1]} – {end.day} {autopost.MONTHS[end.month - 1]}"


def _of_ten(part: int, whole: int) -> str:
    k = round(10 * part / whole)
    return f" — это {k} из 10" if 0 < k < 10 else ""


def week(vacancies: list[Vacancy], now: datetime) -> list[Vacancy]:
    """Общепит Алматы за семь дней, без смен на день. Свежие первыми."""
    cutoff = (now - WINDOW).isoformat()
    ours = [v for v in vacancies if v.city == CITY and v.category == SPHERE and not v.shift_date
            and cutoff <= v.posted_at <= now.isoformat()]
    return sorted(ours, key=lambda v: v.posted_at, reverse=True)


def unique(items: list[Vacancy], name: Callable[[Vacancy], str] = lambda v: v.title.lower()) -> list[Vacancy]:
    """Одна вакансия считается один раз. Повторы из разных каналов склеены ещё при сборе (store.merge); здесь
    повтор — то же заведение (а без него та же должность с зарплатой, autopost.dup_keys), то же название
    и та же сумма: сеть, которая ищет повара за одни деньги в шесть точек, даёт одну цифру, а не шесть."""
    seen, out = set(), []
    for v in items:
        key = (frozenset(autopost.dup_keys(v)) or v.id, name(v), v.salary_period, v.salary_min, v.salary_max)
        if key not in seen:
            seen.add(key)
            out.append(v)
    return out


def _floor(v: Vacancy) -> int | None:
    """Нижняя граница зарплаты, как написано в вакансии: «от 300 000» и «300 000 – 400 000» — это 300 000.
    Вакансии только с верхней границей («до 350 000») не считаем: сколько обещают как минимум, там не сказано."""
    if not v.salary_min or v.salary_period not in LIMITS:
        return None
    low, high = LIMITS[v.salary_period]
    return v.salary_min if low <= v.salary_min <= high else None


# Тема 1: зарплаты по должности

def pay_draft(role: str, items: list[Vacancy], now: datetime) -> Draft | None:
    """items — вакансии одной должности за неделю. Оплату за месяц, за смену и за час не смешиваем:
    каждая считается отдельно и попадает в пост, только если под ней есть PAY_MIN вакансий."""
    mine = unique(items, name=lambda v: role)
    sums = {period: sorted(x for v in mine if v.salary_period == period and (x := _floor(v))) for period in LIMITS}
    enough = [period for period in LIMITS if len(sums[period]) >= PAY_MIN]
    if not enough:
        return None
    main = max(enough, key=lambda period: len(sums[period]))  # при равенстве — за месяц
    where = _locative(CITY)

    def middle(period: str) -> tuple[int, int, int]:
        q1, _, q3 = quantiles(sums[period], n=4)
        return tuple(_round(x, STEP[period]) for x in (median(sums[period]), q1, q3))

    mid, q1, q3 = middle(main)
    xs = sums[main]
    lines = [f"Сколько платят {ROLES[role][2]} в {where} на этой неделе", "",
             f"Середина — {money(mid)} ₸ {PER[main]}: в половине вакансий обещают больше, в половине меньше."]
    spread = f"Самая низкая сумма — {money(xs[0])} ₸, самая высокая — {money(xs[-1])} ₸."
    lines.append(f"Половина вакансий — от {money(q1)} до {money(q3)} ₸. {spread}" if q1 < q3 else spread)
    for period in enough:
        if period != main:
            other, lo, hi = middle(period)
            lines += ["", f"Отдельно {PER[period]}: середина {money(other)} ₸, половина вакансий — от {money(lo)} "
                          f"до {money(hi)} ₸ (по {_vacancies(len(sums[period]), 'dat')})."]
    lines += ["", f"Посчитали по {_vacancies(len(xs), 'dat')} с суммой {FOR[main]}, которые вышли за 7 дней. "
                  f"Брали нижнюю границу: «от {money(300_000)}» считаем как {money(300_000)}.",
              "", f"Все вакансии и отклик в одно нажатие: {_link()}"]
    counted = ", ".join(f"{FOR[period]} — {len(sums[period])}" + ("" if period in enough else " (в пост не пошло)")
                        for period in LIMITS if sums[period])
    basis = (f"{role}, общепит {where}, {_days(now)}: в базе {_vacancies(len(items))}, без повторов {len(mine)}. "
             f"С нижней границей суммы: {counted}. Не считали вакансии без суммы, только с «до …» и с суммой вне "
             f"разумных пределов; шеф и старшие должности — не «{role.lower()}». Порог — {PAY_MIN} вакансий на цифру, "
             f"оплата за месяц, смену и час не смешивается.")
    return Draft("pay", role, "\n".join(lines), basis)


def pay_drafts(items: list[Vacancy], now: datetime) -> list[Draft]:
    by_role: dict[str, list[Vacancy]] = {}
    for v in items:
        if role := role_of(v):
            by_role.setdefault(role, []).append(v)
    return [d for role in ROLES if role in by_role and (d := pay_draft(role, by_role[role], now))]


# Тема 2: заведение, которое нанимает

def _short(title: str) -> str:
    return TAIL.sub("", title).strip(" ,.") or title


def venue_drafts(items: list[Vacancy], reviews: dict | None, known: dict[str, dict], now: datetime) -> list[Draft]:
    """Заведения с несколькими вакансиями за неделю, от большего числа вакансий к меньшему.

    На hh.kz работодатель — часто юрлицо с несколькими ресторанами или ИП с фамилией, поэтому заведение здесь —
    один работодатель по одному адресу, а называем его только так, как назвал агент, проверявший пост (или сам
    работодатель в боте). Нет проверенной вакансии по адресу — заведения в посте нет: имя не угадываем."""
    reviews = reviews or {}
    named = {v.id: v for v in autopost.checked_by_agent(items, reviews)}
    groups: dict[tuple[str, str], list[Vacancy]] = {}
    for v in items:
        if v.employer and v.address and reviews.get(v.id, {}).get("verdict") != "reject":
            place = (venues.key(v.employer, v.city), " ".join(v.address.lower().split()))
            groups.setdefault(place, []).append(named.get(v.id, v))
    out = []
    for group in groups.values():
        face = next((v for v in group if v.id in named and v.employer and v.address), None)
        if not face or PERSON.search(face.employer):
            continue
        if (known.get(venues.key(face.employer, CITY)) or {}).get("status") == "skip":  # это не название заведения
            continue
        jobs = unique(group)
        paid = [v for v in jobs if salary_label(v)]
        if len(paid) < VENUE_MIN:
            continue
        shown = paid[:VENUE_MAX]
        rest = len(jobs) - len(shown)
        lines = [f"Кто нанимает на этой неделе: {face.employer}", "",
                 f"За 7 дней здесь выложили {_vacancies(len(jobs), 'acc')}:",
                 *(f"• {_short(v.title)} — {salary_label(v)}" for v in shown)]
        if rest:
            lines.append(f"И ещё {_vacancies(rest)} — в приложении.")
        lines += ["", f"Адрес: {face.address}", "",
                  f"Открыть вакансию «{_short(face.title)}» и откликнуться: {_link(face.id)}"]
        basis = (f"{face.employer}, {_days(now)}: {_vacancies(len(jobs))} одного работодателя по одному адресу, "
                 f"из них с суммой {len(paid)}. Название и адрес — из вакансии, которую проверил агент; должности и "
                 f"суммы остальных — как в исходных вакансиях. Ничего, кроме текста вакансий, о заведении не сказано. "
                 f"Перед публикацией проверьте название: у сетей одно юрлицо бывает на несколько заведений.")
        out.append((len(jobs), Draft("venue", venues.key(face.employer, CITY), "\n".join(lines), basis)))
    return [d for _, d in sorted(out, key=lambda pair: -pair[0])]


# Тема 3: совет по отклику

def _tip_whatsapp(items: list[Vacancy], now: datetime) -> Draft | None:
    # Какие контакты оставил работодатель, известно только у постов из Telegram-каналов: остальные не считаем
    pool = [v for v in items if v.contact]
    n = len(pool)
    whatsapp = sum(1 for v in pool if "whatsapp" in v.contact)
    if n < SHARE_MIN or whatsapp < 0.2 * n:
        return None
    phone = sum(1 for v in pool if "phone" in v.contact)
    text = "\n".join([
        "Совет по отклику: есть WhatsApp — напишите", "",
        f"За 7 дней мы собрали из Telegram-каналов {_locative(CITY)} {_vacancies(n, 'acc')} общепита с контактами. "
        f"В {whatsapp} из них работодатель оставил WhatsApp{_of_ten(whatsapp, n)}. Телефон для звонка — в {phone}.", "",
        "Начните с короткого сообщения: на какую должность, какой опыт и когда готовы выйти. Оно не потеряется, "
        "даже если работодатель на смене и не берёт трубку.", "",
        f"В приложении WhatsApp работодателя открывается в одно нажатие: {_link()}"])
    basis = (f"Общепит {_locative(CITY)}, {_days(now)}: {_vacancies(n)} из Telegram-каналов с контактами в посте, "
             f"WhatsApp в {whatsapp}, телефон в {phone}. Вакансии с hh.kz и OLX не считали: там отклик идёт через сайт. "
             f"Порог — {SHARE_MIN} вакансий. Данные — только доля; что на сообщения отвечают охотнее, база не знает.")
    return Draft("tip", "whatsapp", text, basis)


def _tip_hours(items: list[Vacancy], now: datetime) -> Draft | None:
    n = len(items)
    hours = [datetime.fromisoformat(v.posted_at).astimezone(LOCAL).hour for v in items]
    morning, evening = sum(1 for h in hours if h < 12), sum(1 for h in hours if h >= 18)
    day = n - morning - evening
    if n < SHARE_MIN or morning + day < 0.7 * n:
        return None
    by_six = round(10 * (morning + day) / n)
    text = "\n".join([
        "Совет по отклику: смотрите вакансии после шести", "",
        f"За 7 дней в {_locative(CITY)} вышло {_vacancies(n)} общепита. До полудня — {morning}, с 12:00 до 18:00 — "
        f"{day}, после 18:00 — {evening}.", "",
        f"К шести вечера выходит {by_six} из 10 вакансий дня. Если смотрите вакансии раз в день, удобнее делать это "
        f"после 18:00.", "",
        f"Свежие вакансии — в приложении: {_link()}"])
    basis = (f"Общепит {_locative(CITY)}, {_days(now)}: {_vacancies(n)} без повторов, по часу публикации в источнике "
             f"(время Алматы). Порог — {SHARE_MIN} вакансий. У вакансии, которую выложили повторно, считается "
             f"последняя публикация.")
    return Draft("tip", "hours", text, basis)


def _tip_pay(items: list[Vacancy], now: datetime) -> Draft | None:
    n = len(items)
    periods = {period: sum(1 for v in items if salary_label(v) and v.salary_period == period) for period in LIMITS}
    paid = sum(periods.values())
    if n < SHARE_MIN or paid == n or paid < 0.5 * n:
        return None
    kinds = ", ".join(f"{FOR[period]} — {count}" for period, count in periods.items() if count)
    text = "\n".join([
        "Совет по отклику: нет суммы — спросите сразу", "",
        f"Из {_vacancies(n, 'gen')} общепита {_locative(CITY)} за 7 дней сумма указана в {paid}{_of_ten(paid, n)}. "
        f"В {n - paid} оплату не назвали.", "",
        f"Там, где сумма есть, считают по-разному: {kinds}. Поэтому в первом сообщении спросите, сколько платят "
        f"и за что: за месяц, за смену или за час.", "",
        f"Вакансии с зарплатой — в приложении: {_link()}"])
    basis = (f"Общепит {_locative(CITY)}, {_days(now)}: {_vacancies(n)} без повторов, с суммой {paid}. "
             f"Порог — {SHARE_MIN} вакансий.")
    return Draft("tip", "pay", text, basis)


def tip_drafts(items: list[Vacancy], now: datetime) -> list[Draft]:
    mine = unique(items)
    return [d for tip in (_tip_whatsapp, _tip_hours, _tip_pay) if (d := tip(mine, now))]


# Что берём сегодня

def plan(vacancies: list[Vacancy], reviews: dict | None, known: dict[str, dict], history: list[dict],
         now: datetime) -> Draft | None:
    """Черновик на сегодня или None, если данных не хватает.

    history — что уже отправляли: [{date, theme, key}]. Тема идёт следующей по кругу за прошлой и с ней не
    совпадает; не хватает данных — берём следующую. Внутри темы — должность (заведение, совет), о которой
    не писали дольше всего."""
    today = now.astimezone(LOCAL).date()
    past = sorted((h for h in history if h["date"] < today.isoformat()), key=lambda h: h["date"])
    last = past[-1] if past else None
    items = week(vacancies, now)
    found = {"pay": pay_drafts(items, now), "venue": venue_drafts(items, reviews, known, now),
             "tip": tip_drafts(items, now)}
    start = THEMES.index(last["theme"]) + 1 if last and last["theme"] in THEMES else today.toordinal()
    used = {(h["theme"], h["key"]): h["date"] for h in past}  # когда о чём писали в последний раз
    recent = (today - VENUE_GAP).isoformat()
    for i in range(len(THEMES)):
        theme = THEMES[(start + i) % len(THEMES)]
        if last and theme == last["theme"]:
            continue
        drafts = [d for d in found[theme] if not (theme == "venue" and used.get((theme, d.key), "") > recent)]
        # В посте не должно быть телефонов: они могут прийти только из названия или адреса вакансии
        drafts = [d for d in drafts if not contacts.PHONE.search(d.text.rsplit("\n", 1)[0])]
        if drafts:
            return min(drafts, key=lambda d: used.get((theme, d.key), ""))  # давно не было — первым
    return None


def load_history(data_dir: Path) -> list[dict]:
    try:
        return json.loads((data_dir / STATE).read_text("utf-8"))["sent"]
    except (OSError, ValueError, KeyError):
        return []


def remember(data_dir: Path, draft: Draft, now: datetime) -> None:
    today = now.astimezone(LOCAL).date().isoformat()
    sent = [h for h in load_history(data_dir) if h["date"] != today]  # повторный запуск за день заменяет запись
    sent.append({"date": today, "theme": draft.theme, "key": draft.key})
    (data_dir / STATE).write_text(json.dumps({"sent": sent[-KEEP:]}, ensure_ascii=False, indent=1) + "\n", "utf-8")


# Отправка модераторам

NOTE = ("📝 Выше — черновик поста «не вакансия» для {chat}. Код в канал его не публикует: прочитайте, поправьте "
        "и опубликуйте сами.\n\nТема: {theme}.\nНа чём посчитано: {basis}\n\nСсылка в посте помечена в воронке "
        "как «{source}».")
EMPTY = (f"📝 Сегодня черновика поста «не вакансия» нет: за 7 дней данных не хватило ни на одну тему "
         f"(или хватило только на вчерашнюю, а её не повторяем). Пороги: зарплаты — {PAY_MIN} вакансий с суммой на должность, заведение — {VENUE_MIN} вакансии "
         f"с суммой по одному адресу, совет — {SHARE_MIN} вакансий.")


def note(draft: Draft) -> str:
    return NOTE.format(chat=autopost.CHANNELS[CITY], theme=THEME_NAMES[draft.theme], basis=draft.basis, source=SOURCE)


def send(client: httpx.Client, token: str, chats: list[int], draft: Draft | None) -> dict:
    """Отправляет черновик модераторам: пост отдельным сообщением без разметки (его можно скопировать как есть),
    следом справка. Нет черновика — одно сообщение о том, что данных сегодня нет."""
    api = tg.url(token, "sendMessage")
    stats = {"sent": 0, "failed": 0}
    for chat in chats:
        try:
            for text in [draft.text, note(draft)] if draft else [EMPTY]:
                tg.check(client.post(api, json={"chat_id": chat, "text": text, "disable_web_page_preview": True}))
            stats["sent"] += 1
        except (httpx.HTTPError, RuntimeError) as exc:
            # В тексте сетевой ошибки адрес запроса с токеном: в лог только её вид
            log.warning("черновик в чат модератора: %s", tg.error_text(exc))
            stats["failed"] += 1
    return stats

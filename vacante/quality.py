"""Качество сбора: материал для агента-технолога (.claude/skills/improve-parser).

- rejected.json в ветке data: очищенный текст отброшенных постов (без телефонов и ссылок), чтобы
  проверять, правильно ли их отбросили, и прогонять через новые правила без повторного чтения каналов.
- report(): сводка по журналу и вакансиям с примерами, которые стоит посмотреть глазами.
- replay(): что изменит правка parse.py на уже собранных постах по сравнению с базовой версией правил.
"""

from __future__ import annotations

import importlib.util
import json
import random
import re
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import ModuleType

from vacante import parse
from vacante.journal import ACCEPTED, DUPLICATE, REJECTED
from vacante.models import RawPost, Vacancy
from vacante.parse import GENERIC_TITLE, REJECT_REASONS, clean_text

MAX_REJECTED = 4000
SHOW_TEXT = 700  # столько символов текста поста показывает отчёт
_MONEY = re.compile(r"\d[\d\s.,]*\s*(?:к\b|k\b|тыс|тг|тенге|₸)")


# --- rejected.json -------------------------------------------------------------------------------

def load_rejected(data_dir: Path) -> dict[str, dict] | None:
    """None, если файла ещё нет: тогда сбор перечитывает каналы, чтобы его наполнить."""
    path = data_dir / "rejected.json"
    if not path.exists():
        return None
    return {p["id"]: p for p in json.loads(path.read_text("utf-8"))}


def rejected_item(post: RawPost, reason: str) -> dict:
    return {"id": f"{post.channel.lower()}-{post.post_id}", "channel": post.channel, "url": post.url,
            "posted_at": post.posted_at.isoformat(timespec="seconds"), "city": post.default_city,
            "reason": reason, "text": clean_text(post.text)}


def dropped_item(vacancy: Vacancy, reason: str) -> dict:
    """Карточка, которую новые правила больше не считают вакансией."""
    channel = vacancy.id.rpartition("-")[0]
    return {"id": vacancy.id, "channel": channel, "url": vacancy.source_url, "posted_at": vacancy.posted_at,
            "city": vacancy.city, "reason": reason, "text": vacancy.text}


def save_rejected(data_dir: Path, items: dict[str, dict], journal_posts: dict[str, dict]) -> None:
    """Хранит только посты, которые журнал сейчас считает отброшенными, с их нынешней причиной."""
    kept = []
    for item in items.values():
        entry = journal_posts.get(item["id"])
        if entry and entry["status"] == REJECTED:
            kept.append({**item, "reason": entry["reason"]})
    kept.sort(key=lambda p: p["posted_at"], reverse=True)
    payload = json.dumps(kept[:MAX_REJECTED], ensure_ascii=False, indent=0)
    (data_dir / "rejected.json").write_text(payload + "\n", "utf-8")


# --- report --------------------------------------------------------------------------------------

def _load(data_dir: Path, name: str, default):
    path = data_dir / name
    return json.loads(path.read_text("utf-8")) if path.exists() else default


def _pct(part: int, whole: int) -> str:
    return f"{round(100 * part / whole)}%" if whole else "—"


def _show(text: str) -> str:
    text = text.strip()
    text = text if len(text) <= SHOW_TEXT else text[:SHOW_TEXT].rstrip() + "…"
    return "\n".join("    " + line for line in text.splitlines() if line.strip())


def _salary(v: dict) -> str:
    if v["salary_min"] is None and v["salary_max"] is None:
        return "—"
    return f"{v['salary_min'] or ''}–{v['salary_max'] or ''} {v['salary_period'] or '?'}"


def report(data_dir: Path, now: datetime | None = None, days: int = 7, per_reason: int = 6,
           accepted_sample: int = 12, seed: str | None = None) -> str:
    """Сводка в Markdown: цифры по каналам и причинам, заполненность полей, примеры для проверки."""
    now = now or datetime.now(timezone.utc)
    rng = random.Random(seed or now.date().isoformat())  # каждый день другие примеры, в течение дня те же
    journal = _load(data_dir, "journal.json", {"channels": {}, "posts": []})
    rejected = load_rejected(data_dir) or {}
    vacancies = [v for v in _load(data_dir, "vacancies.json", []) if v["source"] == "telegram"]
    since = (now - timedelta(days=days)).isoformat()
    day_ago = (now - timedelta(days=1)).isoformat()
    posts = [p for p in journal["posts"] if p["posted_at"] >= since]
    out = [f"# Качество сбора на {now:%Y-%m-%d %H:%M} UTC", ""]

    out += [f"## Итого за {days} дн. и за сутки", "", "| | за период | за сутки |", "|---|---|---|"]
    recent = [p for p in posts if p["posted_at"] >= day_ago]
    for label, test in [("постов", lambda p: True), ("принято", lambda p: p["status"] == ACCEPTED),
                        ("дублей", lambda p: p["status"] == DUPLICATE),
                        ("отброшено", lambda p: p["status"] == REJECTED)]:
        out.append(f"| {label} | {sum(map(test, posts))} | {sum(map(test, recent))} |")
    for code, label in REJECT_REASONS.items():
        n = sum(p["reason"] == code for p in posts if p["status"] == REJECTED)
        if n:
            out.append(f"| — {code} ({label}) | {n} | "
                       f"{sum(p['reason'] == code for p in recent if p['status'] == REJECTED)} |")

    out += ["", "## Каналы", "",
            "Доля принятых считается без дублей. ⚠ — стоит посмотреть: ошибка чтения, нет постов, "
            "или принято меньше 30%.", "",
            "| канал | город | постов | принято | дублей | отброшено | частая причина | последняя проверка |",
            "|---|---|---|---|---|---|---|---|"]
    by_channel: dict[str, Counter] = defaultdict(Counter)
    reasons: dict[str, Counter] = defaultdict(Counter)
    for p in posts:
        by_channel[p["channel"].lower()][p["status"]] += 1
        if p["status"] == REJECTED:
            reasons[p["channel"].lower()][p["reason"]] += 1
    rows = []
    for name, info in journal["channels"].items():
        c = by_channel[name.lower()]
        total, accepted = sum(c.values()), c[ACCEPTED]
        unique = total - c[DUPLICATE]
        flag = info.get("error") or total == 0 or (unique >= 5 and accepted / unique < 0.3)
        top = reasons[name.lower()].most_common(1)
        checked = f"{info.get('checked_at', '')[:16]} {info.get('error') or ''}".strip()
        rows.append((not flag, -total, f"| {'⚠ ' if flag else ''}{name} | {info.get('city') or '—'} | {total} | "
                     f"{accepted} ({_pct(accepted, unique)}) | {c[DUPLICATE]} | {c[REJECTED]} | "
                     f"{top[0][0] if top else '—'} | {checked} |"))
    out += [row for *_, row in sorted(rows)]

    out += ["", f"## Поля принятых вакансий из каналов ({len(vacancies)} на сайте)", ""]
    n = len(vacancies)
    fields = [
        ("с зарплатой", lambda v: v["salary_min"] or v["salary_max"]),
        ("с графиком", lambda v: v["schedule"]),
        ("с работодателем", lambda v: v["employer"]),
        ("с адресом", lambda v: v.get("address")),
        (f"должность «{GENERIC_TITLE}»", lambda v: v["title"] == GENERIC_TITLE),
        ("несколько должностей", lambda v: ", " in v["title"]),
        ("без города", lambda v: not v["city"]),
    ]
    for label, test in fields:
        k = sum(bool(test(v)) for v in vacancies)
        out.append(f"- {label}: {k} ({_pct(k, n)})")

    out += ["", "## Отброшенные посты: правильно ли?", "",
            "Ищи настоящие рабочие вакансии в Казахстане, которые правила отбросили, и мусор, который проходит.", ""]
    texts = [r for r in rejected.values() if r["posted_at"] >= since]
    if not texts:
        out += ["Текстов отброшенных постов пока нет (rejected.json пишется при сборе).", ""]
    for code, label in REJECT_REASONS.items():
        pool = [r for r in texts if r["reason"] == code]
        if not pool:
            continue
        out += [f"### {code}: {label} ({len(pool)} с текстом)", ""]
        for r in rng.sample(pool, min(per_reason, len(pool))):
            out += [f"- {r['url']} ({r['city'] or 'город ?'})", _show(r["text"]), ""]

    out += ["## Принятые вакансии: верно ли разобраны?", ""]
    recent_v = [v for v in vacancies if v["posted_at"] >= since]
    groups = [
        (f"Должность «{GENERIC_TITLE}»", [v for v in recent_v if v["title"] == GENERIC_TITLE]),
        ("Без зарплаты, хотя в тексте есть сумма", [v for v in recent_v if not (v["salary_min"] or v["salary_max"])
                                                    and _has_money(v["text"])]),
        ("Случайные", recent_v),
    ]
    shown: set[str] = set()
    for title, pool in groups:
        pool = [v for v in pool if v["id"] not in shown]
        if not pool:
            continue
        out += [f"### {title} ({len(pool)})", ""]
        for v in rng.sample(pool, min(accepted_sample if title == "Случайные" else per_reason, len(pool))):
            shown.add(v["id"])
            out += [f"- {v['source_url']}: **{v['title']}** · город {v['city'] or '—'} · зп {_salary(v)} · "
                    f"график {v['schedule'] or '—'} · работодатель {v['employer'] or '—'} · "
                    f"адрес {v.get('address') or '—'} · {', '.join(v['perks']) or 'без плюсов'}",
                    _show(v["text"]), ""]
    return "\n".join(out).rstrip() + "\n"


def _has_money(text: str) -> bool:
    return bool(_MONEY.search(text.lower()))


# --- replay --------------------------------------------------------------------------------------

def load_parser(source: str, name: str = "vacante_parse_base") -> ModuleType:
    """Модуль правил из текста parse.py (например, из origin/main), рядом с текущим vacante.parse."""
    spec = importlib.util.spec_from_loader(name, loader=None)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    exec(compile(source, f"<{name}>", "exec"), module.__dict__)
    return module


def base_parser(ref: str) -> ModuleType:
    source = subprocess.run(["git", "show", f"{ref}:vacante/parse.py"], check=True, capture_output=True,
                            text=True).stdout
    return load_parser(source)


def _fields(vacancy: Vacancy | None, reason: str | None) -> dict:
    if vacancy is None:
        return {"verdict": f"отброшено ({reason})"}
    return {"verdict": "принято", "title": vacancy.title, "city": vacancy.city,
            "salary": (vacancy.salary_min, vacancy.salary_max, vacancy.salary_period),
            "schedule": vacancy.schedule, "employer": vacancy.employer, "address": vacancy.address,
            "perks": vacancy.perks}


def replay(data_dir: Path, base: ModuleType, new: ModuleType = parse, examples: int = 8) -> tuple[dict, str]:
    """Прогоняет все сохранённые посты (принятые и отброшенные) через базовые и новые правила.

    Возвращает (счётчики изменений, отчёт в Markdown с примерами)."""
    posts = []
    for v in _load(data_dir, "vacancies.json", []):
        if v["source"] == "telegram":
            channel, _, post_id = v["id"].rpartition("-")
            posts.append((v["source_url"], RawPost("telegram", channel, int(post_id), v["source_url"], v["text"],
                                                   datetime.fromisoformat(v["posted_at"]), v["city"])))
    for r in (load_rejected(data_dir) or {}).values():
        channel, _, post_id = r["id"].rpartition("-")
        posts.append((r["url"], RawPost("telegram", channel, int(post_id), r["url"], r["text"],
                                        datetime.fromisoformat(r["posted_at"]), r["city"])))
    changes: dict[str, list[str]] = defaultdict(list)
    for url, post in posts:
        before, after = _fields(*base.explain(post)), _fields(*new.explain(post))
        if before == after:
            continue
        if before["verdict"] != after["verdict"]:
            key = ("стало принято" if after["verdict"] == "принято"
                   else "стало отброшено" if before["verdict"] == "принято" else "другая причина отказа")
            detail = f"{before['verdict']} → {after['verdict']}"
            if "title" in after:
                detail += f": **{after['title']}**"
            changes[key].append(f"- {url}: {detail}\n{_show(post.text)}")
            continue
        for field in before:
            if before[field] != after[field]:
                changes[f"поле {field}"].append(f"- {url}: {before[field]!r} → {after[field]!r}")
    counts = {key: len(items) for key, items in sorted(changes.items())}
    lines = [f"# Что изменят новые правила ({len(posts)} сохранённых постов)", ""]
    if not counts:
        lines.append("Изменений нет.")
    for key, items in sorted(changes.items()):
        lines += ["", f"## {key}: {len(items)}", ""] + items[:examples]
        if len(items) > examples:
            lines.append(f"- … и ещё {len(items) - examples}")
    return counts, "\n".join(lines) + "\n"

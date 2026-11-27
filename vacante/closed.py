"""Архив закрытых вакансий: что показать по ссылке на вакансию, которой на сайте уже нет.

Вакансия живёт на сайте две недели, а ссылки на неё живут дольше: в постах наших каналов, в поиске,
в ответах ChatGPT. Чтобы страница 404 могла сказать «Вакансия «Официант» в Астане закрыта» и показать
похожие, сбор запоминает ушедшие вакансии в closed.json папки данных: id → название, город, сфера и
день, когда вакансия ушла с сайта. Работодателя, текста и контактов здесь нет.

В архив попадает только то, что ушло само: вышел срок или работодатель закрыл свою вакансию в боте.
То, что с сайта убрали (пост перестал считаться вакансией, канал отключён или убран из сбора по просьбе
владельца), в архив не попадает, а прежние записи такого канала из него уходят: см. leavers и update.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path

from vacante import direct
from vacante.models import Vacancy
from vacante.sources import hh, olx

FILE = "closed.json"
# Сколько дней помним закрытую вакансию
KEEP_DAYS = 60
# На сайте архив лежит частями closed/<n>.json, чтобы страница 404 скачивала одну маленькую часть, а не всё.
# Число простое: остаток от деления на него раскладывает id по частям ровно
SHARDS = 509
# Источники со своими id («hh-123»). У постов из каналов id начинается с имени канала («chan-123»)
OWN_IDS = (hh.SOURCE, olx.SOURCE, direct.SOURCE)
_ID = re.compile(r"[A-Za-z0-9_-]+")


def shard(vacancy_id: str) -> int:
    """В какой части архива лежит вакансия. Точно так же считает страница 404 в браузере (templates/404.html)."""
    n = 0
    for ch in vacancy_id:
        n = (n * 31 + ord(ch)) % SHARDS
    return n


def entry(v: Vacancy, day: str) -> dict:
    """Что помним о закрытой вакансии: только то, что нужно странице 404."""
    item = {"title": v.title, "city": v.city, "category": v.category, "closed": day}
    if v.title_kk:
        item["title_kk"] = v.title_kk
    return item


def _checked(key: str, item: object) -> dict | None:
    """Запись из файла: только известные поля и только годные значения, иначе None."""
    if not _ID.fullmatch(key) or not isinstance(item, dict):
        return None
    title, title_kk, city, category, day = (item.get(k) for k in ("title", "title_kk", "city", "category", "closed"))
    if not (isinstance(title, str) and title.strip() and isinstance(category, str) and isinstance(day, str)):
        return None
    try:
        day = date.fromisoformat(day).isoformat()
    except ValueError:
        return None
    out = {"title": title, "city": city if isinstance(city, str) else None, "category": category, "closed": day}
    if isinstance(title_kk, str) and title_kk.strip():
        out["title_kk"] = title_kk
    return out


def load(data_dir: Path) -> dict[str, dict]:
    """Архив из closed.json. Файла нет или он испорчен — архив пуст: ни сбор, ни сборка сайта из-за него не падают."""
    try:
        raw = json.loads((data_dir / FILE).read_text("utf-8"))
    except (OSError, ValueError, RecursionError):
        return {}
    if not isinstance(raw, dict):
        return {}
    checked = ((key, _checked(key, item)) for key, item in raw.items())
    return {key: item for key, item in checked if item}


def save(data_dir: Path, archive: dict[str, dict]) -> None:
    """По строке на вакансию, по порядку id: в ветке data файл меняется только там, где изменился архив."""
    data_dir.mkdir(parents=True, exist_ok=True)
    lines = [f"{json.dumps(key)}: {json.dumps(archive[key], ensure_ascii=False, sort_keys=True)}" for key in sorted(archive)]
    (data_dir / FILE).write_text("{\n" + ",\n".join(lines) + "\n}\n" if lines else "{}\n", "utf-8")


def leavers(saved: list[Vacancy], merged: list[Vacancy], kept: list[Vacancy],
            from_bot: list[Vacancy] | None) -> list[Vacancy]:
    """Кого из бывших на сайте (saved) запомнить после прохода сбора (collect.run).

    Двое: у кого вышел срок (дошёл до expire: есть в merged, нет в kept) и чью вакансию закрыл сам работодатель
    (бот её больше не отдаёт; from_bot None — базу бота не прочитали, и такие вакансии остались как были).
    Список нарочно перечисляет, кого брать, а не кого пропускать: всё, что ушло иначе (пост больше не считается
    вакансией, канал отключён, источник неизвестен, карточку убрали из файла руками), в архив не попадёт,
    даже если в сборе появится новый способ уйти.
    """
    was, live = {v.id for v in saved}, {v.id for v in kept}
    expired = [v for v in merged if v.id in was and v.id not in live]
    if from_bot is None:
        return expired
    still_open = {v.id for v in from_bot}
    return expired + [v for v in saved if v.source == direct.SOURCE and v.id not in still_open]


def _may_keep(key: str, channels: set[str]) -> bool:
    """Можно ли помнить вакансию с таким id: она из своего источника (hh, OLX, бот) или из включённого канала."""
    source = key.rpartition("-")[0]
    return bool(_ID.fullmatch(key)) and (source in OWN_IDS or source in channels)


def update(data_dir: Path, gone: list[Vacancy], live: list[Vacancy], channels: set[str], now: datetime) -> int:
    """Дописывает ушедшие вакансии (leavers) в архив и чистит его; возвращает, сколько в нём записей.

    Из архива уходят вакансии, которые снова на сайте (live), записи старше KEEP_DAYS и записи каналов, которых
    сейчас нет среди включённых (channels: их имена строчными буквами). Последнее — обещание владельцам каналов
    из подвала сайта: канал отключили или убрали из сбора — от его постов не остаётся и названий. Поэтому
    и вакансии такого канала, у которых просто вышел срок, сюда не записываются.
    """
    archive = load(data_dir)
    day = now.date().isoformat()
    archive.update((v.id, entry(v, day)) for v in gone)
    alive = {v.id for v in live}
    oldest = (now.date() - timedelta(days=KEEP_DAYS)).isoformat()
    archive = {key: item for key, item in archive.items()
               if key not in alive and item["closed"] >= oldest and _may_keep(key, channels)}
    save(data_dir, archive)
    return len(archive)

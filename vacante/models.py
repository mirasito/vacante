from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime


@dataclass
class RawPost:
    """Пост как он пришёл из источника, до разбора."""

    source: str  # "telegram"
    channel: str
    post_id: int
    url: str
    text: str
    posted_at: datetime
    default_city: str | None = None
    # Адреса ссылок поста: wa.me, tel:, t.me/… (в тексте видна только подпись ссылки)
    links: list[str] = field(default_factory=list)


@dataclass
class Vacancy:
    """Карточка вакансии после разбора и нормализации."""

    id: str
    title: str
    category: str
    city: str | None
    salary_min: int | None
    salary_max: int | None
    salary_period: str | None  # "month" | "day" | "hour"
    schedule: str | None
    perks: list[str]
    employer: str | None
    text: str
    source: str
    source_url: str
    posted_at: str  # ISO 8601, UTC
    fingerprint: str
    also_seen_in: list[str] = field(default_factory=list)
    address: str | None = None  # без города: «ул. Сыганак, 2»
    top_until: str | None = None  # до когда оплачено «🔥 Срочно» (ISO 8601, UTC), только у вакансий из бота
    title_kk: str | None = None  # казахская часть двуязычного названия с hh.kz, для казахской версии сайта
    # Какие контакты есть в исходном посте (vacante.contacts.KINDS), без самих номеров и имён
    contact: list[str] = field(default_factory=list)
    # Точка адреса работы (vacante.geo.city_point): по ней приложение показывает, далеко ли от дома.
    # geo — откуда точка: "hh" (ставит hh.kz) или "osm" (нашли адрес в OpenStreetMap, vacante.geocode)
    lat: float | None = None
    lon: float | None = None
    geo: str | None = None

    def is_top(self, now: datetime) -> bool:
        return self.top_until is not None and datetime.fromisoformat(self.top_until) > now

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> Vacancy:
        return cls(**data)

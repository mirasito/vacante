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

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> Vacancy:
        return cls(**data)

"""Точки вакансий на карте: центры городов и расстояние по прямой.

Точка нужна приложению, чтобы показать, далеко ли работа от дома соискателя. Сам дом приложение
знает только у себя (с сервера профилей), а лента с точками вакансий одна для всех.
Точку вакансии берём, только если она рядом со своим городом: адрес на hh иногда стоит
в другом городе, а перепутанные широта и долгота уводят в другую страну.
"""

from __future__ import annotations

import re
from math import asin, cos, radians, sin, sqrt

# Адрес, который можно найти на карте: с номером дома или торговым, бизнес- или жилым центром
MAP_WORTHY = re.compile(r"(?i)\d|\b(?:трц|трк|тц|тд|бц|жк)\b")

# Центры городов vacante.kz (те же ключи, что в parse.CITIES): широта, долгота
CENTRES: dict[str, tuple[float, float]] = {
    "almaty": (43.2380, 76.9450),
    "astana": (51.1280, 71.4304),
    "shymkent": (42.3155, 69.5869),
    "karaganda": (49.8047, 73.1094),
    "aktobe": (50.2839, 57.1670),
    "atyrau": (47.0945, 51.9238),
    "aktau": (43.6500, 51.1600),
    "pavlodar": (52.2873, 76.9674),
    "ust-kamenogorsk": (49.9483, 82.6275),
    "semey": (50.4111, 80.2275),
    "kostanay": (53.2144, 63.6246),
    "uralsk": (51.2278, 51.3865),
    "taraz": (42.9000, 71.3667),
    "turkestan": (43.2973, 68.2518),
    "petropavlovsk": (54.8753, 69.1628),
    "kyzylorda": (44.8528, 65.5092),
    "kokshetau": (53.2948, 69.4047),
    "taldykorgan": (45.0156, 78.3739),
}
# Дальше от центра точка считается ошибкой. С запасом на пригороды Алматы и Астаны
CITY_RADIUS_KM = 50
# Четыре знака после запятой — около 10 метров: адрес работы и так публичный
DIGITS = 4


def distance_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Расстояние по прямой между двумя точками (широта, долгота)."""
    lat1, lon1, lat2, lon2 = map(radians, (*a, *b))
    h = sin((lat2 - lat1) / 2) ** 2 + cos(lat1) * cos(lat2) * sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371 * asin(sqrt(h))


def city_point(city: str | None, lat: object, lon: object) -> tuple[float, float] | None:
    """Точка вакансии, если это числа и она не дальше CITY_RADIUS_KM от центра её города."""
    centre = CENTRES.get(city or "")
    if centre is None or not all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in (lat, lon)):
        return None
    point = (round(float(lat), DIGITS), round(float(lon), DIGITS))
    return point if distance_km(centre, point) <= CITY_RADIUS_KM else None

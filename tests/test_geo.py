from datetime import datetime, timezone

from vacante import geo
from vacante.parse import CITIES
from vacante.site import appfeed
from vacante.sources import hh

NOW = datetime(2026, 11, 4, 12, tzinfo=timezone.utc)


def item(id_, address=None):
    return {"id": str(id_), "name": "Официант", "area": {"id": "160", "name": "Алматы"},
            "published_at": "2026-11-04T10:00:00+0500", "alternate_url": f"https://hh.kz/vacancy/{id_}",
            "address": address}


def test_every_city_has_a_centre():
    assert set(geo.CENTRES) == set(CITIES)


def test_city_point_rounds_and_checks_the_city():
    assert geo.city_point("almaty", 43.238912, 76.912345) == (43.2389, 76.9123)
    assert geo.city_point("almaty", 43.47, 77.02) is not None  # пригород, в пределах 50 км
    assert geo.city_point("almaty", 51.128, 71.43) is None  # Астана
    assert geo.city_point("astana", 71.43, 51.128) is None  # перепутаны широта и долгота
    assert geo.city_point(None, 43.2, 76.9) is None
    assert geo.city_point("almaty", True, 76.9) is None
    assert geo.city_point("almaty", float("nan"), 76.9) is None


def test_distance_km():
    km = geo.distance_km(geo.CENTRES["almaty"], geo.CENTRES["astana"])
    assert 950 < km < 990  # Алматы — Астана по прямой


def test_app_feed_has_the_point():
    with_point = hh.to_vacancy(item(1, {"raw": "Алматы, Абая, 150", "lat": 43.2389, "lng": 76.9123}))
    data = appfeed.item(with_point, "https://vacante.kz", NOW, {})
    assert (data["lat"], data["lon"]) == (43.2389, 76.9123)
    without = appfeed.item(hh.to_vacancy(item(2)), "https://vacante.kz", NOW, {})
    assert "lat" not in without and "lon" not in without

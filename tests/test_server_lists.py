"""Сервер в Казахстане (server/, TypeScript) держит свой список городов для анкеты соискателя.
Он должен совпадать с городами сбора вакансий, иначе в анкете не окажется нового города."""

import re
from pathlib import Path

from vacante.parse import CITIES

ROOT = Path(__file__).resolve().parent.parent


def test_server_cities_match_parser():
    source = (ROOT / "server" / "src" / "profile.ts").read_text("utf-8")
    block = re.search(r"export const CITIES = \[(.*?)\] as const;", source, re.S)
    assert block, "в server/src/profile.ts нет списка CITIES"
    assert re.findall(r'"([a-z-]+)"', block.group(1)) == list(CITIES)


def test_server_city_names_match_site():
    from vacante.site.i18n import CITIES_KK

    source = (ROOT / "server" / "src" / "labels.ts").read_text("utf-8")
    names = dict(
        (slug, (ru, kk))
        for slug, ru, kk in re.findall(r'"?([a-z-]+)"?: \["([^"]+)", "([^"]+)"\]', source)
        if slug in CITIES
    )
    assert names == {slug: (CITIES[slug][0], CITIES_KK[slug]) for slug in CITIES}

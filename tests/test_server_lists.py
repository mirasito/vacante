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


def test_server_contact_rules_match_parser():
    """Номер из поста сервер ищет теми же правилами, по которым разбор отмечает виды контактов."""
    from vacante import contacts

    source = (ROOT / "server" / "src" / "contacts.ts").read_text("utf-8")

    def pattern(name: str) -> str:
        found = re.search(rf"^const {name} = /(.*)/[a-z]*;$", source, re.M)
        assert found, f"в server/src/contacts.ts нет {name}"
        # В JavaScript \w без кириллицы, поэтому там [\p{L}\p{N}_]
        return found.group(1).replace(r"\p{L}\p{N}_", r"\w").replace(r"[\w]", r"\w").replace(r"\/", "/")

    for name in ("PHONE", "WHATSAPP", "USERNAME", "PROMO"):
        assert pattern(name) == getattr(contacts, name).pattern, name

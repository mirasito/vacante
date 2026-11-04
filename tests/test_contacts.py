from datetime import datetime, timezone

from vacante import contacts
from vacante.collect import reparse, with_contact
from vacante.models import RawPost
from vacante.parse import parse_post
from vacante.site import appfeed
from vacante.sources.telegram import parse_channel_page
from vacante.store import merge

TEXT = "Требуется бариста в кофейню «Зерно», 2/2, 12 000 тг за смену, обучение"


def post(text: str, links: list[str] | None = None, post_id: int = 1, channel: str = "almaty_jobs") -> RawPost:
    return RawPost("telegram", channel, post_id, f"https://t.me/{channel}/{post_id}", text,
                   datetime(2026, 11, 4, tzinfo=timezone.utc), "almaty", links or [])


def test_kinds_from_text_and_links():
    assert contacts.kinds(TEXT + "\nWhatsApp: 8 701 123 45 67") == ["whatsapp", "phone"]
    assert contacts.kinds(TEXT + "\nЗвоните +7 (727) 300-00-00") == ["phone"]
    assert contacts.kinds(TEXT + "\nПишите в ватсап") == ["whatsapp"]
    # Номер спрятан за подписью ссылки
    assert contacts.kinds(TEXT + "\nНаписать в WhatsApp", ["https://wa.me/77011234567"]) == ["whatsapp", "phone"]
    assert contacts.kinds(TEXT + "\nПозвонить", ["tel:+77011234567"]) == ["phone"]
    assert contacts.kinds(TEXT + "\nРезюме: @hr_zerno") == ["telegram"]
    assert contacts.kinds(TEXT + "\nНаписать HR", ["https://t.me/hr_zerno"]) == ["telegram"]
    assert contacts.kinds(TEXT) == []


def test_channel_promo_is_not_a_contact():
    text = TEXT + "\n\nПодписывайтесь на @almaty_jobs\nПо вопросам рекламы: @admin_jobs, 8 777 000 00 00"
    assert contacts.kinds(text, ["https://t.me/almaty_jobs/120", "https://t.me/almaty_jobs"], "almaty_jobs") == []
    # Свой канал в тексте вакансии — тоже не контакт, а вот HR рядом — контакт
    assert contacts.kinds(TEXT + "\nВакансии: t.me/almaty_jobs, резюме @hr_zerno", [], "almaty_jobs") == ["telegram"]


def test_channel_page_keeps_link_addresses():
    html = """<div class="tgme_widget_message" data-post="almaty_jobs/5">
      <div class="tgme_widget_message_text">Требуется бариста<br>
        <a href="https://wa.me/77011234567">Написать в WhatsApp</a><br>
        <a href="https://t.me/almaty_jobs">Подписаться на канал</a></div>
      <a class="tgme_widget_message_date"><time datetime="2026-11-04T05:00:00+00:00"></time></a></div>"""
    [raw] = parse_channel_page(html, "almaty_jobs", "almaty")
    assert raw.links == ["https://wa.me/77011234567"]
    assert "77011234567" not in raw.text


def test_contact_kinds_survive_reparse_and_reach_the_app_feed():
    raw = post(TEXT + "\nWhatsApp 8 701 123 45 67")
    vacancy = with_contact(parse_post(raw), raw)
    assert vacancy.contact == ["whatsapp", "phone"]
    assert "701" not in vacancy.text  # сам номер в карточку не попадает
    # Повторный разбор идёт по очищенному тексту: контакты остаются от исходного поста
    [again] = reparse([vacancy], {"almaty_jobs": "almaty"})
    assert again.contact == ["whatsapp", "phone"]
    item = appfeed.item(again, "https://vacante.kz", datetime(2026, 11, 4, tzinfo=timezone.utc), {})
    assert item["contact"] == ["whatsapp", "phone"]
    assert "contact" not in appfeed.item(parse_post(post(TEXT, post_id=2)), "https://vacante.kz",
                                         datetime(2026, 11, 4, tzinfo=timezone.utc), {})


def test_rescan_fills_contacts_of_cards_saved_before():
    raw = post(TEXT + "\nWhatsApp 8 701 123 45 67")
    saved = parse_post(raw)
    assert saved.contact == []  # сохранена до поиска контактов
    fresh = with_contact(parse_post(raw), raw)
    [result] = merge([saved], [fresh])
    assert result is saved and result.contact == ["whatsapp", "phone"]

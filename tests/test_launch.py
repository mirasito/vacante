from dataclasses import replace
from datetime import datetime, timezone

from vacante.launch import app_link, reply_buttons, start_param
from vacante.models import RawPost
from vacante.parse import parse_post


def test_vacancy_link():
    assert start_param(source="tg", city="almaty", vacancy_id="hh-139501020") == "stg_v_almaty_hh-139501020"


def test_city_with_hyphen_and_id_with_underscore():
    assert (
        start_param(source="tg", city="ust-kamenogorsk", vacancy_id="astana_job_vakansii-130653")
        == "stg_v_ust-kamenogorsk_astana_job_vakansii-130653"
    )


def test_city_only_and_no_source():
    assert start_param(city="almaty") == "c_almaty"
    assert start_param(source="ad12", city="almaty") == "sad12_c_almaty"


def test_too_long_gives_none():
    assert start_param(source="tg", city="ust-kamenogorsk", vacancy_id="a" * 50) is None


def test_bad_source_gives_none():
    assert start_param(source="TG ads", city="almaty") is None


def test_bad_city_or_id_gives_none():
    assert start_param(city="Almaty_1") is None
    assert start_param(city="almaty", vacancy_id="hh 1") is None
    assert start_param(vacancy_id="hh-1") is None
    assert start_param() is None


def test_app_link():
    assert app_link("stg_c_almaty") == "https://t.me/vacantekz_bot?startapp=stg_c_almaty"


def vacancy(**changes):
    raw = RawPost("telegram", "chan", 5, "https://t.me/chan/5", "Кафе «Зерно» ищет бариста, 300 000 тг",
                  datetime(2026, 10, 27, tzinfo=timezone.utc), "almaty")
    return replace(parse_post(raw), **changes)


def test_reply_buttons_follow_contacts_of_the_post():
    # Прямые кнопки: сервер сразу отправляет к работодателю и знает, откуда нажали и по какой вакансии
    link = "https://api.vacante.kz/go/chan-5/{}?s={}&t=%D0%91%D0%B0%D1%80%D0%B8%D1%81%D1%82%D0%B0"
    v = vacancy(contact=["whatsapp", "phone", "telegram"])
    assert reply_buttons(v, "web") == [("whatsapp", link.format("wa", "web")), ("phone", link.format("call", "web")),
                                       ("telegram", link.format("tg", "web"))]
    assert reply_buttons(vacancy(contact=["phone"]), "tg") == [("phone", link.format("call", "tg"))]


def test_reply_button_is_app_link_when_server_cannot_find_the_post():
    app = [("apply", "https://t.me/vacantekz_bot?startapp=sweb_v_almaty_hh-7")]
    # hh.kz и OLX: исходного поста в канале нет, отклик идёт через приложение
    assert reply_buttons(vacancy(id="hh-7", source="hh", contact=[]), "web") == app
    assert reply_buttons(vacancy(id="hh-7", source="olx", contact=["phone"]), "web") == app


def test_reply_button_without_contacts_is_plain_apply():
    assert reply_buttons(vacancy(contact=[]), "web") == [
        ("apply", "https://t.me/vacantekz_bot?startapp=sweb_v_almaty_chan-5")]


def test_no_reply_buttons_for_employer_vacancies_shifts_and_long_links():
    assert reply_buttons(vacancy(source="bot"), "web") == []  # отклик идёт работодателю через бота
    assert reply_buttons(vacancy(shift_date="2026-10-28"), "web") == []  # «Беру смену» в боте
    assert reply_buttons(vacancy(id="a" * 60, contact=[]), "web") == []  # ссылка в приложение не помещается
    assert reply_buttons(vacancy(city=None), "web") == []

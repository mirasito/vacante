from dataclasses import replace
from datetime import datetime, timezone

from vacante.launch import app_link, profile_link, reply_buttons, start_param, utm
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


def test_apply_link_opens_the_apply_window_and_view_link_stays_as_it_was():
    # «a_» — сразу окно отклика, «v_» — карточка вакансии (заголовки в утренней подборке и старые ссылки)
    assert start_param(source="tg", city="almaty", vacancy_id="hh-1", apply=True) == "stg_a_almaty_hh-1"
    assert start_param(source="tg", city="almaty", vacancy_id="hh-1") == "stg_v_almaty_hh-1"
    # Без вакансии откликаться не на что: лента города
    assert start_param(source="tg", city="almaty", apply=True) == "stg_c_almaty"
    # Ссылка на отклик не длиннее ссылки на карточку: предел Telegram тот же
    longest = "x" * (64 - len("stgpf_a_almaty_"))
    assert len(start_param(source="tgpf", city="almaty", vacancy_id=longest, apply=True)) == 64
    assert start_param(source="tgpf", city="almaty", vacancy_id=longest + "x", apply=True) is None


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
    app = [("apply", "https://t.me/vacantekz_bot?startapp=sweb_a_almaty_hh-7")]
    # hh.kz и OLX: исходного поста в канале нет, отклик идёт через приложение
    assert reply_buttons(vacancy(id="hh-7", source="hh", contact=[]), "web") == app
    assert reply_buttons(vacancy(id="hh-7", source="olx", contact=["phone"]), "web") == app


def test_reply_button_without_contacts_is_plain_apply():
    assert reply_buttons(vacancy(contact=[]), "web") == [
        ("apply", "https://t.me/vacantekz_bot?startapp=sweb_a_almaty_chan-5")]


def test_no_reply_buttons_for_employer_vacancies_shifts_and_long_links():
    assert reply_buttons(vacancy(source="bot"), "web") == []  # отклик идёт работодателю через бота
    assert reply_buttons(vacancy(shift_date="2026-10-28"), "web") == []  # «Беру смену» в боте
    assert reply_buttons(vacancy(id="a" * 60, contact=[]), "web") == []  # ссылка в приложение не помещается
    assert reply_buttons(vacancy(city=None), "web") == []


def test_profile_link_goes_with_direct_buttons_only():
    # Рядом с прямыми кнопками — путь в приложение, где отклик уходит со ссылкой на профиль
    v = vacancy(contact=["whatsapp"])
    assert profile_link(v, "web") == "https://t.me/vacantekz_bot?startapp=swebpf_a_almaty_chan-5"
    assert profile_link(v, "tg") == "https://t.me/vacantekz_bot?startapp=stgpf_a_almaty_chan-5"
    # Кнопка отклика и так ведёт в приложение: вторая такая же не нужна
    assert profile_link(vacancy(contact=[]), "web") is None
    assert profile_link(vacancy(source="bot"), "web") is None
    assert profile_link(vacancy(id="a" * 60, source="telegram", contact=["whatsapp"]), "web") is None


def test_utm_marks_site_links_sent_to_telegram():
    assert utm("https://vacante.kz/v/chan-5/", "channel", "post", "almaty") == (
        "https://vacante.kz/v/chan-5/?utm_source=telegram&utm_medium=channel&utm_campaign=post&utm_content=almaty")
    # Город неизвестен: метки utm_content нет
    assert utm("https://vacante.kz/smeny/", "bot", "morning") == (
        "https://vacante.kz/smeny/?utm_source=telegram&utm_medium=bot&utm_campaign=morning")
    assert utm("https://vacante.kz/", "bot", "sub", None).endswith("/?utm_source=telegram&utm_medium=bot&utm_campaign=sub")
    assert utm("https://vacante.kz", "bot", "sub") == "https://vacante.kz?utm_source=telegram&utm_medium=bot&utm_campaign=sub"


def test_utm_keeps_query_and_fragment_of_the_link():
    # У адреса уже есть параметры: метки дописываются через «&», второго «?» нет
    assert utm("https://vacante.kz/almaty/?q=%D0%BF%D0%BE%D0%B2%D0%B0%D1%80&sort=pay", "bot", "sub", "almaty") == (
        "https://vacante.kz/almaty/?q=%D0%BF%D0%BE%D0%B2%D0%B0%D1%80&sort=pay"
        "&utm_source=telegram&utm_medium=bot&utm_campaign=sub&utm_content=almaty")
    # Якорь остаётся в конце адреса, после меток
    assert utm("https://vacante.kz/rabotodatelyam/?from=tg#tarify", "channel", "post", "ust-kamenogorsk") == (
        "https://vacante.kz/rabotodatelyam/?from=tg&utm_source=telegram&utm_medium=channel&utm_campaign=post"
        "&utm_content=ust-kamenogorsk#tarify")
    assert utm("https://vacante.kz/almaty/#list", "bot", "examples").endswith("/almaty/?utm_source=telegram"
                                                                              "&utm_medium=bot&utm_campaign=examples#list")
    # Адрес сайта при локальной сборке: порт и путь остаются как есть
    assert utm("http://localhost:8000/vacante/v/chan-5/", "bot", "sub", "almaty").startswith(
        "http://localhost:8000/vacante/v/chan-5/?utm_source=telegram&")

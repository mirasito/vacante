from vacante.launch import app_link, start_param


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

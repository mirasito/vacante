import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import httpx

from vacante import contacts, draft
from vacante.models import RawPost
from vacante.parse import parse_post

NOW = datetime(2026, 11, 16, 3, tzinfo=timezone.utc)  # 8:00 в Казахстане
LINK = "https://t.me/vacantekz_bot?startapp=stgnv_c_almaty"
YESTERDAY = "2026-11-15"


def make(post_id: int, text: str, city: str = "almaty", hours_ago: int = 5):
    raw = RawPost("telegram", "chan", post_id, f"https://t.me/chan/{post_id}", text, NOW - timedelta(hours=hours_ago), city)
    return parse_post(raw)


def staff(whom: str, pays: list[int], start: int, tail: str = ""):
    """По вакансии на сумму (в тысячах), у каждой своё заведение."""
    return [make(start + i, f"Кафе «Луна {start + i}» ищет {whom}, {pay} 000 тг{tail}") for i, pay in enumerate(pays)]


BARISTAS = [200, 220, 250, 260, 280, 300, 320, 350, 400, 600]


def venue(start: int = 900, employer: str = "ТОО Еда и Ко", address: str = "ул. Абая, 10"):
    """Три вакансии одного работодателя по одному адресу; первую проверил агент и назвал заведение."""
    jobs = [make(start, "Требуется повар горячего цеха в ресторан Сад, от 400 000 тг"),
            make(start + 1, "Требуется официант, 300 000 – 500 000 тг"),
            make(start + 2, "Требуется хостес")]
    jobs = [replace(v, employer=employer, address=address) for v in jobs]
    reviews = {jobs[0].id: {"verdict": "approve", "fields": {"employer": "Ресторан «Сад»", "title": "Повар горячего цеха"}}}
    return jobs, reviews


def test_pay_draft_gives_the_middle_and_the_spread_for_one_role():
    items = staff("бариста", BARISTAS, 100)
    (d,) = draft.pay_drafts(items, NOW)
    assert (d.theme, d.key) == ("pay", "Бариста")
    lines = d.text.split("\n")
    assert lines[0] == "Сколько платят бариста в Алматы на этой неделе"
    assert lines[2] == "Середина — 290\xa0000 ₸ в месяц: в половине вакансий обещают больше, в половине меньше."
    assert lines[3] == ("Половина вакансий — от 240\xa0000 до 360\xa0000 ₸. Самая низкая сумма — 200\xa0000 ₸, "
                        "самая высокая — 600\xa0000 ₸.")
    assert "Посчитали по 10 вакансиям с суммой за месяц, которые вышли за 7 дней." in d.text
    assert lines[-1] == f"Все вакансии и отклик в одно нажатие: {LINK}"
    assert "Луна" not in d.text  # заведений в посте о зарплатах не называем
    # Справка для человека: сколько вакансий под цифрой и за какие дни
    assert "9–16 ноября: в базе 10 вакансий, без повторов 10" in d.basis and "за месяц — 10" in d.basis


def test_pay_per_month_per_shift_and_per_hour_are_never_mixed():
    monthly = staff("бариста", BARISTAS[:7], 100)
    shifts = staff("бариста", [10, 11, 12, 13, 14], 200, " за смену")
    # Двенадцать вакансий с суммой, но ни за месяц, ни за смену восьми не набирается: цифры нет
    assert draft.pay_drafts(monthly + shifts, NOW) == []
    (d,) = draft.pay_drafts(staff("бариста", BARISTAS, 100) + staff("бариста", [10, 11, 12, 13, 14, 15, 16, 18], 200,
                                                                    " за смену"), NOW)
    assert "Середина — 290\xa0000 ₸ в месяц" in d.text  # оплата за смену в месячную середину не попала
    assert "Отдельно за смену: середина 14\xa0000 ₸, половина вакансий — от 11\xa0000 до 16\xa0000 ₸ (по 8 вакансиям)." in d.text
    assert "за месяц — 10, за смену — 8" in d.basis


def test_pay_counts_only_stated_lower_bounds_and_skips_seniors_and_typos():
    seven = staff("бариста", BARISTAS[:7], 100)
    up_to = replace(make(150, "Кафе «Сад» ищет бариста, 350 000 тг"), salary_min=None, salary_max=350_000)
    no_pay = make(151, "Кафе «Мята» ищет бариста")
    typo = replace(make(152, "Кафе «Лес» ищет бариста, 350 000 тг"), salary_min=5_000_000)
    senior = replace(make(153, "Кафе «Море» ищет бариста, 500 000 тг"), title="Старший бариста")
    assert draft.pay_drafts(seven + [up_to, no_pay, typo, senior], NOW) == []
    assert len(draft.pay_drafts(seven + [make(154, "Кафе «Дом» ищет бариста, 310 000 тг")], NOW)) == 1


def test_one_vacancy_is_counted_once():
    seven = staff("бариста", BARISTAS[:7], 100)
    # Сеть ищет бариста за одни деньги в пять точек: это одна цифра, а не пять
    chain = [replace(make(160 + i, "Кофейня «Зерно» ищет бариста, 310 000 тг"), title=f"Бариста, точка {i}") for i in range(5)]
    assert len(draft.unique(chain, name=lambda v: "Бариста")) == 1
    assert draft.pay_drafts(seven + chain[:1], NOW) != [] and "по 8 вакансиям" in draft.pay_drafts(seven + chain, NOW)[0].text


def test_only_fresh_almaty_horeca_is_counted():
    old = [replace(v, posted_at=(NOW - timedelta(days=8)).isoformat()) for v in staff("бариста", BARISTAS, 100)]
    astana = [replace(v, city="astana") for v in staff("бариста", BARISTAS, 200)]
    other = [replace(v, category="retail") for v in staff("бариста", BARISTAS, 300)]
    shift = [replace(v, shift_date="2026-11-17") for v in staff("бариста", BARISTAS, 400)]
    assert draft.week(old + astana + other + shift, NOW) == []
    assert draft.plan(old + astana + other + shift, None, {}, [], NOW) is None


def test_venue_draft_lists_what_one_place_is_hiring_for():
    jobs, reviews = venue()
    (d,) = draft.venue_drafts(jobs, reviews, {}, NOW)
    assert (d.theme, d.key) == ("venue", "almaty:ресторан сад")
    assert d.text.split("\n") == [
        "Кто нанимает на этой неделе: Ресторан «Сад»", "",
        "За 7 дней здесь выложили 3 вакансии:",
        "• Повар горячего цеха — от 400\xa0000 ₸/мес",
        "• Официант — 300\xa0000 – 500\xa0000 ₸/мес",
        "И ещё 1 вакансия — в приложении.", "",
        "Адрес: ул. Абая, 10", "",
        "Открыть вакансию «Повар горячего цеха» и откликнуться: "
        "https://t.me/vacantekz_bot?startapp=stgnv_v_almaty_chan-900"]
    assert "3 вакансии одного работодателя по одному адресу, из них с суммой 2" in d.basis


def test_venue_is_named_only_as_the_agent_named_it():
    jobs, reviews = venue()
    assert draft.venue_drafts(jobs, None, {}, NOW) == []  # никто не проверял: имя не угадываем
    assert draft.venue_drafts(jobs, {jobs[0].id: {"verdict": "reject", "reason": "реклама"}}, {}, NOW) == []
    # ИП с фамилией вместо названия и то, что агент по заведениям счёл не названием, в пост не идут
    person = {jobs[0].id: {"verdict": "approve", "fields": {"employer": "Иванов И. И."}}}
    assert draft.venue_drafts(jobs, person, {}, NOW) == []
    assert draft.venue_drafts(jobs, reviews, {"almaty:ресторан сад": {"status": "skip"}}, NOW) == []
    # Одно юрлицо на два адреса — это два заведения: вакансии по другому адресу в список не идут
    apart = [jobs[0], replace(jobs[1], address="пр. Достык, 5"), jobs[2]]
    assert draft.venue_drafts(apart, reviews, {}, NOW) == []
    # Одной вакансии с суммой мало
    assert draft.venue_drafts([jobs[0], jobs[2]], reviews, {}, NOW) == []


def crowd(n: int = 30, whatsapp: int = 12):
    """n разных вакансий из каналов с контактами (должность не из тех, по которым считаем зарплаты);
    у первых whatsapp есть WhatsApp, у 18 сумма за месяц, у 6 за смену, у остальных суммы нет."""
    items = staff("повара", [300] * n, 500)
    items = [replace(v, title=f"Хостес {i}", salary_min=None if i >= 24 else v.salary_min,
                     salary_period=None if i >= 24 else "day" if i >= 18 else "month",
                     contact=["phone", "whatsapp"] if i < whatsapp else ["phone"],
                     posted_at=(NOW - timedelta(days=1)).replace(hour=1 + i // 2).isoformat())
             for i, v in enumerate(items)]
    return items


def test_tips_rest_on_shares_from_the_base():
    tips = {d.key: d for d in draft.tip_drafts(crowd(), NOW)}
    assert list(tips) == ["whatsapp", "hours", "pay"]
    assert ("собрали из Telegram-каналов Алматы 30 вакансий общепита с контактами. В 12 из них работодатель оставил "
            "WhatsApp — это 4 из 10. Телефон для звонка — в 30.") in tips["whatsapp"].text
    # Час публикации по времени Алматы: 1:00–15:59 UTC это 6:00–20:59
    assert "вышло 30 вакансий общепита. До полудня — 12, с 12:00 до 18:00 — 12, после 18:00 — 6." in tips["hours"].text
    assert "К шести вечера выходит 8 из 10 вакансий дня." in tips["hours"].text
    assert ("Из 30 вакансий общепита Алматы за 7 дней сумма указана в 24 — это 8 из 10. В 6 оплату не назвали."
            in tips["pay"].text)
    assert "считают по-разному: за месяц — 18, за смену — 6." in tips["pay"].text
    assert all(d.text.endswith(LINK) and "30 вакансий" in d.basis for d in tips.values())


def test_no_share_without_thirty_vacancies():
    assert draft.tip_drafts(crowd(29), NOW) == []
    # Контакты известны только у постов из каналов: вакансии без контактов в долю WhatsApp не идут
    few = [replace(v, contact=[]) if i % 2 else v for i, v in enumerate(crowd(40, 40))]
    assert [d.key for d in draft.tip_drafts(few, NOW)] == ["hours", "pay"]
    assert "whatsapp" not in [d.key for d in draft.tip_drafts(crowd(30, 5), NOW)]  # WhatsApp почти нигде: не совет


def everything():
    jobs, reviews = venue()
    return staff("бариста", BARISTAS, 100) + staff("официанта", BARISTAS, 200) + jobs + crowd(), reviews


def test_theme_changes_every_day_and_follows_the_circle():
    items, reviews = everything()
    plan = lambda history, data=items: draft.plan(data, reviews, {}, history, NOW)  # noqa: E731
    # Без истории тема берётся по дню: 16 ноября — заведение
    assert plan([]).theme == "venue"
    assert plan([{"date": YESTERDAY, "theme": "pay", "key": "Бариста"}]).theme == "venue"
    assert plan([{"date": YESTERDAY, "theme": "venue", "key": "almaty:другое"}]).theme == "tip"
    assert plan([{"date": YESTERDAY, "theme": "tip", "key": "hours"}]).theme == "pay"
    # На тему по очереди данных нет: берём следующую, но не вчерашнюю
    no_venue = [v for v in items if v.address is None]
    assert plan([{"date": YESTERDAY, "theme": "pay", "key": "Бариста"}], no_venue).theme == "tip"
    assert plan([{"date": YESTERDAY, "theme": "tip", "key": "hours"}], no_venue).theme == "pay"
    only_tips = crowd()
    assert plan([{"date": YESTERDAY, "theme": "pay", "key": "Бариста"}], only_tips).theme == "tip"
    assert plan([{"date": YESTERDAY, "theme": "tip", "key": "hours"}], only_tips) is None  # вчерашнюю не повторяем
    assert plan([], staff("бариста", BARISTAS[:5], 100)) is None  # данных нет ни на одну тему


def test_role_venue_and_tip_do_not_repeat_while_there_are_others():
    items, reviews = everything()
    plan = lambda history: draft.plan(items, reviews, {}, history, NOW)  # noqa: E731
    tip = {"date": YESTERDAY, "theme": "tip", "key": "hours"}
    assert plan([tip]).key == "Официант"  # должности по порядку: о ком ещё не писали
    assert plan([{"date": "2026-11-12", "theme": "pay", "key": "Официант"}, tip]).key == "Бариста"
    assert plan([{"date": "2026-11-09", "theme": "pay", "key": "Официант"},
                 {"date": "2026-11-12", "theme": "pay", "key": "Бариста"}, tip]).key == "Официант"  # давно не было
    venue_day = {"date": YESTERDAY, "theme": "venue", "key": "almaty:другое"}
    assert plan([venue_day]).key == "whatsapp"
    assert plan([{"date": "2026-11-12", "theme": "tip", "key": "whatsapp"}, venue_day]).key == "hours"
    # Одно заведение — не чаще раза в неделю: тогда сегодня совет
    pay = {"date": YESTERDAY, "theme": "pay", "key": "Бариста"}
    assert plan([{"date": "2026-11-12", "theme": "venue", "key": "almaty:ресторан сад"}, pay]).theme == "tip"
    assert plan([{"date": "2026-11-08", "theme": "venue", "key": "almaty:ресторан сад"}, pay]).theme == "venue"
    # Повторный запуск в тот же день даёт тот же черновик: сегодняшняя запись не в счёт
    today = {"date": "2026-11-16", "theme": "venue", "key": "almaty:ресторан сад"}
    assert plan([pay, today]).key == "almaty:ресторан сад"


def test_no_phone_numbers_in_the_post():
    jobs, reviews = venue(address="ул. Абая, 10, тел. 8 701 123 45 67")
    assert contacts.PHONE.search(draft.venue_drafts(jobs, reviews, {}, NOW)[0].text)
    pay = [{"date": YESTERDAY, "theme": "pay", "key": "Бариста"}]
    assert draft.plan(jobs, reviews, {}, pay, NOW) is None  # с телефоном черновик не уходит
    items, reviews = everything()
    for history in ([], pay, [{"date": YESTERDAY, "theme": "venue", "key": "x"}], [{"date": YESTERDAY, "theme": "tip", "key": "x"}]):
        text = draft.plan(items, reviews, {}, history, NOW).text
        assert not contacts.PHONE.search(text.rsplit("\n", 1)[0]) and "startapp=stgnv_" in text.rsplit("\n", 1)[1]


def test_history_is_kept_next_to_vacancies(tmp_path):
    assert draft.load_history(tmp_path) == []
    d = draft.Draft("pay", "Бариста", "пост", "справка")
    draft.remember(tmp_path, d, NOW - timedelta(days=1))
    draft.remember(tmp_path, d, NOW)
    draft.remember(tmp_path, replace(d, theme="tip", key="hours"), NOW)  # второй запуск за день заменяет запись
    assert draft.load_history(tmp_path) == [{"date": YESTERDAY, "theme": "pay", "key": "Бариста"},
                                            {"date": "2026-11-16", "theme": "tip", "key": "hours"}]
    assert json.loads((tmp_path / "drafts.json").read_text("utf-8"))["sent"][0]["key"] == "Бариста"


def test_draft_goes_to_moderators_as_plain_post_and_a_note():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.url.path.rsplit("/", 1)[1], json.loads(request.content)))
        return httpx.Response(200, json={"ok": True, "result": {}})

    (d,) = draft.pay_drafts(staff("бариста", BARISTAS, 100), NOW)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert draft.send(client, "1:t", [900, 901], d) == {"sent": 2, "failed": 0}
        assert [name for name, _ in calls] == ["sendMessage"] * 4  # в канал ничего: только сообщения модераторам
        assert [body["chat_id"] for _, body in calls] == [900, 900, 901, 901]
        post, note = calls[0][1], calls[1][1]
        assert post["text"] == d.text and "parse_mode" not in post  # пост можно скопировать как есть
        assert "черновик поста «не вакансия» для @vacantealmaty" in note["text"]
        assert "Тема: зарплаты по должности." in note["text"] and d.basis in note["text"] and "«tgnv»" in note["text"]
        calls.clear()
        # Данных нет: одно короткое сообщение
        assert draft.send(client, "1:t", [900], None) == {"sent": 1, "failed": 0}
        assert len(calls) == 1 and "Сегодня черновика поста «не вакансия» нет" in calls[0][1]["text"]


def test_failed_chat_does_not_stop_the_rest():
    def handler(request: httpx.Request) -> httpx.Response:
        if json.loads(request.content)["chat_id"] == 900:
            return httpx.Response(403, json={"ok": False, "description": "Forbidden: bot was blocked by the user"})
        return httpx.Response(200, json={"ok": True, "result": {}})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert draft.send(client, "1:t", [900, 901], draft.Draft("tip", "hours", "пост", "справка")) == {"sent": 1, "failed": 1}

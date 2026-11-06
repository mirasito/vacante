import argparse
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

import httpx

from vacante import autopost, channels, collect, digest, direct, geocode, instagram, quality, review, venues
from vacante.site import build
from vacante.store import load_vacancies


def main() -> None:
    parser = argparse.ArgumentParser(prog="vacante")
    sub = parser.add_subparsers(dest="command", required=True)

    p_collect = sub.add_parser("collect", help="собрать новые вакансии из источников")
    p_collect.add_argument("--config", type=Path, default=Path("config/telegram_channels.yaml"))
    p_collect.add_argument("--data-dir", type=Path, default=Path("data"))
    p_collect.add_argument("--max-age-days", type=int, default=14)

    p_post = sub.add_parser("post", help="опубликовать свежие вакансии в свои Telegram-каналы")
    p_post.add_argument("--data-dir", type=Path, default=Path("data"))
    p_post.add_argument("--base-url", default="https://vacante.kz")

    p_digest = sub.add_parser("digest", help="разослать подписчикам бота подборки новых вакансий")
    p_digest.add_argument("--data-dir", type=Path, default=Path("data"))
    p_digest.add_argument("--base-url", default="https://vacante.kz")

    p_venues = sub.add_parser("venues", help="заведения: Instagram и аватары")
    p_venues.add_argument("action", choices=["apply", "avatars", "set-avatar"],
                          help="apply: записать находки агента из VENUES_RESULTS и скачать аватары (Instagram по API, "
                               "Telegram, сайт); avatars: только скачать аватары; set-avatar: поставить аватар вручную")
    p_venues.add_argument("--data-dir", type=Path, default=Path("data"))
    p_venues.add_argument("--name", help="set-avatar: название заведения, как на сайте")
    p_venues.add_argument("--city", help="set-avatar: город, например almaty")
    p_venues.add_argument("--image", type=Path, help="set-avatar: картинка")
    p_venues.add_argument("--instagram", help="set-avatar: Instagram заведения")

    p_review = sub.add_parser("review", help="записать решения агента по постам в каналы из REVIEW_DECISIONS")
    p_review.add_argument("--data-dir", type=Path, default=Path("data"))

    p_quality = sub.add_parser("quality", help="агенту-технологу: сводка качества сбора с примерами постов")
    p_quality.add_argument("--data-dir", type=Path, default=Path("data"))
    p_quality.add_argument("--days", type=int, default=7)

    p_geocheck = sub.add_parser("geocheck", help="насколько точен поиск адресов: сверка с точками hh.kz")
    p_geocheck.add_argument("--data-dir", type=Path, default=Path("data"))
    p_geocheck.add_argument("--sample", type=int, default=100, help="сколько адресов проверить")

    p_replay = sub.add_parser("replay", help="агенту-технологу: что изменит правка parse.py на сохранённых постах")
    p_replay.add_argument("--data-dir", type=Path, default=Path("data"))
    p_replay.add_argument("--base-ref", default="origin/main", help="с какой версией parse.py сравнивать")
    p_replay.add_argument("--examples", type=int, default=8)

    p_ig = sub.add_parser("instagram", help="подборки вакансий в Instagram по городам")
    p_ig.add_argument("action", choices=["plan", "publish"],
                      help="plan: карточки и план на этот час в <out>/ig/; publish: опубликовать план (INSTAGRAM_TOKEN)")
    p_ig.add_argument("--data-dir", type=Path, default=Path("data"))
    p_ig.add_argument("--out", type=Path, default=Path("public"), help="plan: куда положить карточки (сайт)")
    p_ig.add_argument("--plan", type=Path, help="publish: файл плана (по умолчанию <out>/ig/plan.json)")
    p_ig.add_argument("--base-url", default="https://vacante.kz")

    p_crm = sub.add_parser("crm", help="отправить работодателей, заведения и вакансии в CRM на сервере api.vacante.kz")
    p_crm.add_argument("--data-dir", type=Path, default=Path("data"))

    p_build = sub.add_parser("build", help="собрать статический сайт")
    p_build.add_argument("--data-dir", type=Path, default=Path("data"))
    p_build.add_argument("--out", type=Path, default=Path("public"))
    p_build.add_argument("--base-url", default="https://vacante.kz")

    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # иначе в лог попадают адреса запросов, а в них токен бота
    if args.command == "collect":
        stats = collect.run(args.config, args.data_dir, args.max_age_days, direct=direct_vacancies(args.data_dir),
                            locate=geocode.locate)
        stats["venues_queue"] = venues.write_queue(args.data_dir, load_vacancies(args.data_dir))
        stats["post_queue"] = autopost.write_review_queue(args.data_dir)
        logging.info("сбор: %s", stats)
        if geo := stats.get("geocode"):
            # Итог поиска адресов виден в сводке прогона и через REST API, без скачивания логов
            level = "warning" if geo.get("stopped") else "notice"
            print(f"::{level} title=Поиск адресов::{geocode.summary(geo).replace('%', '%25')}")
    elif args.command == "geocheck":
        lines = geocode.check_report(geocode.check(load_vacancies(args.data_dir), args.sample))
        text = "\n".join(lines).replace("%", "%25").replace("\r", "").replace("\n", "%0A")
        print(f"::notice title=Проверка поиска адресов::{text}")
    elif args.command == "quality":
        print(quality.report(args.data_dir, days=args.days))
    elif args.command == "replay":
        print(quality.replay(args.data_dir, quality.base_parser(args.base_ref), examples=args.examples)[1])
    elif args.command == "venues":
        run_venues(args)
    elif args.command == "review":
        run_review(args)
    elif args.command == "instagram":
        run_instagram(args)
    elif args.command == "post":
        token = os.environ.get("TELEGRAM_BOT_TOKEN")
        if not token:
            logging.info("автопостинг: нет TELEGRAM_BOT_TOKEN, пропускаю")
            return
        with httpx.Client(timeout=30) as client:
            live = channels.refresh(args.data_dir, channels.telegram_checker(client, token), datetime.now(timezone.utc))
            stats = autopost.run(args.data_dir, args.base_url, autopost.telegram_sender(client, token),
                                 pin=autopost.telegram_pinner(client, token), live=live,
                                 send_text=autopost.telegram_text_sender(client, token))
        logging.info("автопостинг: %s", stats)
    elif args.command == "crm":
        from vacante import crm_sync
        # Итог видно в аннотации «CRM работодателей» запуска, без чтения логов
        try:
            stats = crm_sync.run(args.data_dir, load_vacancies(args.data_dir))
        except httpx.HTTPError as e:
            status = f"HTTP {e.response.status_code}" if isinstance(e, httpx.HTTPStatusError) else type(e).__name__
            print(f"::warning title=CRM работодателей::сервер не принял снимок: {status}")
            raise
        logging.info("CRM: %s", stats)
        if stats:
            print(f"::notice title=CRM работодателей::работодателей {stats['employers']}, заведений {stats['venues']}, "
                  f"вакансий сейчас {stats['active']}, в архив {stats['archived']}, из бота {stats.get('bot_jobs', 0)}, "
                  f"оплат {stats.get('payments', 0)}, карточек hh {stats.get('hh', 0)}")
    elif args.command == "digest":
        env = {k: os.environ.get(k) for k in ("TELEGRAM_BOT_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN")}
        if not all(env.values()):
            logging.info("подборки: нет секретов бота или Cloudflare, пропускаю")
            return
        with httpx.Client(timeout=30) as client:
            d1 = digest.D1(client, env["CLOUDFLARE_ACCOUNT_ID"], env["CLOUDFLARE_API_TOKEN"])
            if d1.database_id() is None:
                logging.info("подборки: базы бота ещё нет (бот не выложен), пропускаю")
                return
            stats = digest.run(args.data_dir, args.base_url, d1.subscriptions,
                               digest.telegram_sender(client, env["TELEGRAM_BOT_TOKEN"]))
            d1.deactivate(stats["blocked"])
            try:
                jobs = d1.job_counts()
            except (httpx.HTTPError, RuntimeError):
                jobs = None  # таблиц вакансий ещё нет: бот не перевыложен
            bot = {"updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                   "subscribers": d1.subscriber_counts(), "jobs": jobs}
            (args.data_dir / "bot.json").write_text(json.dumps(bot, ensure_ascii=False) + "\n", "utf-8")
        logging.info("подборки: %s", stats)
    else:
        password = os.environ.get("ADMIN_PASSWORD") or None
        if not password:
            logging.warning("админка: нет ADMIN_PASSWORD, данные админки не публикую")
        count = build.build(args.data_dir, args.out, args.base_url, admin_password=password)
        logging.info("сайт: %s страниц в %s", count, args.out)


def annotate(report: list[tuple[str, str]], title: str) -> None:
    """Итог ещё и аннотациями: агент читает их через REST API, без скачивания логов.
    GitHub сохраняет не больше 10 аннотаций одного уровня на шаг, поэтому все строки в одной аннотации."""
    for level in ("notice", "error"):
        lines = [f"{key}: {outcome}" for key, outcome in report if outcome.startswith("error") == (level == "error")]
        if lines:
            text = "\n".join(lines).replace("%", "%25").replace("\r", "").replace("\n", "%0A")
            print(f"::{level} title={title}::{text}")


def run_instagram(args: argparse.Namespace) -> None:
    if args.action == "plan":
        posts = instagram.plan(args.data_dir, args.out, args.base_url)
        logging.info("instagram: подборки на этот час: %s", ", ".join(p["city"] for p in posts) or "нет")
        return
    token = os.environ.get("INSTAGRAM_TOKEN")
    if not token:
        print("::notice title=Instagram в ленту::нет секрета INSTAGRAM_TOKEN, пропускаю")
        return
    path = args.plan or args.out / instagram.PLAN
    posts = json.loads(path.read_text("utf-8"))["posts"] if path.exists() else []
    with httpx.Client(timeout=60) as client:
        publisher = instagram.Publisher(venues.InstagramAPI(client, token))
        annotate(instagram.publish(args.data_dir, posts, publisher), "Instagram в ленту")


def run_review(args: argparse.Namespace) -> None:
    try:
        decisions = json.loads(os.environ.get("REVIEW_DECISIONS") or "")
    except ValueError:
        decisions = None
    if not isinstance(decisions, list) or not decisions or not all(isinstance(d, dict) for d in decisions):
        print("::error::REVIEW_DECISIONS: нужен непустой JSON-массив объектов {id, verdict, fields | reason}")
        raise SystemExit(1)
    report = review.apply(args.data_dir, decisions, load_vacancies(args.data_dir))
    annotate(report, "Посты")
    if any(outcome.startswith("error") for _, outcome in report):
        raise SystemExit(1)


def run_venues(args: argparse.Namespace) -> None:
    if args.action == "set-avatar":
        key = venues.set_avatar(args.data_dir, args.name, args.city, args.image.read_bytes(), args.instagram)
        logging.info("заведения: аватар %s", key)
        return
    if args.action == "apply":
        try:
            results = json.loads(os.environ.get("VENUES_RESULTS") or "[]")
        except ValueError:
            results = None
        if not isinstance(results, list) or not all(isinstance(r, dict) for r in results):
            print("::error::VENUES_RESULTS: нужен JSON-массив объектов {key, status, instagram, telegram, website}")
            raise SystemExit(1)
        annotate(venues.apply(args.data_dir, results), "Заведения")
    with httpx.Client(timeout=20, follow_redirects=True) as client:
        sources = {}
        if token := os.environ.get("INSTAGRAM_TOKEN"):
            instagram = venues.InstagramAPI(client, token)
            annotate(instagram.check(), "Instagram")
            # Instagram ещё не привязан: это видно в аннотации «Instagram», а «Аватары» не засоряем
            # ошибкой на каждом заведении, и агент не пишет о ней каждый час
            if instagram.linked is not False and not instagram.instagram_login:
                sources["instagram"] = instagram.avatar
        if token := os.environ.get("TELEGRAM_BOT_TOKEN"):
            sources["telegram"] = venues.TelegramAvatars(client, token).avatar
        sources["website"] = venues.WebsiteLogo(client).avatar
        annotate(venues.fetch_avatars(args.data_dir, sources), "Аватары")


def direct_vacancies(data_dir: Path) -> list | None:
    """Одобренные вакансии от работодателей из базы бота, или None, если её не прочитать.

    Заодно выкладывает в data/moderation.json очередь на проверку для агента-модератора."""
    env = {k: os.environ.get(k) for k in ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN")}
    if not all(env.values()):
        return None
    try:
        with httpx.Client(timeout=30) as client:
            d1 = digest.D1(client, env["CLOUDFLARE_ACCOUNT_ID"], env["CLOUDFLARE_API_TOKEN"])
            if d1.database_id() is None:
                return None
            queue = {"updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                     "jobs": [direct.queue_item(job) for job in d1.review_queue()]}
            data_dir.mkdir(parents=True, exist_ok=True)
            (data_dir / "moderation.json").write_text(json.dumps(queue, ensure_ascii=False, indent=1) + "\n", "utf-8")
            today = datetime.now(direct.LOCAL).date().isoformat()
            # Прошедшие смены бот закрывает сам, но до его будильника они не должны висеть на сайте
            return [direct.to_vacancy(job) for job in d1.approved_jobs()
                    if not (direct.is_shift(job) and job["shift_date"] < today)]
    except (httpx.HTTPError, RuntimeError) as exc:
        logging.warning("вакансии от работодателей: %s", exc if isinstance(exc, RuntimeError) else type(exc).__name__)
        return None


if __name__ == "__main__":
    main()

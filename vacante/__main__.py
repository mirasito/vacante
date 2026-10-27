import argparse
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

import httpx

from vacante import autopost, collect, digest, direct
from vacante.site import build


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

    p_build = sub.add_parser("build", help="собрать статический сайт")
    p_build.add_argument("--data-dir", type=Path, default=Path("data"))
    p_build.add_argument("--out", type=Path, default=Path("public"))
    p_build.add_argument("--base-url", default="https://vacante.kz")

    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # иначе в лог попадают адреса запросов, а в них токен бота
    if args.command == "collect":
        stats = collect.run(args.config, args.data_dir, args.max_age_days, direct=direct_vacancies())
        logging.info("сбор: %s", stats)
    elif args.command == "post":
        token = os.environ.get("TELEGRAM_BOT_TOKEN")
        if not token:
            logging.info("автопостинг: нет TELEGRAM_BOT_TOKEN, пропускаю")
            return
        with httpx.Client(timeout=30) as client:
            stats = autopost.run(args.data_dir, args.base_url, autopost.telegram_sender(client, token))
        logging.info("автопостинг: %s", stats)
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
        count = build.build(args.data_dir, args.out, args.base_url)
        logging.info("сайт: %s страниц в %s", count, args.out)


def direct_vacancies() -> list | None:
    """Одобренные вакансии от работодателей из базы бота, или None, если её не прочитать."""
    env = {k: os.environ.get(k) for k in ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN")}
    if not all(env.values()):
        return None
    try:
        with httpx.Client(timeout=30) as client:
            d1 = digest.D1(client, env["CLOUDFLARE_ACCOUNT_ID"], env["CLOUDFLARE_API_TOKEN"])
            if d1.database_id() is None:
                return None
            return [direct.to_vacancy(job) for job in d1.approved_jobs()]
    except (httpx.HTTPError, RuntimeError) as exc:
        logging.warning("вакансии от работодателей: %s", exc if isinstance(exc, RuntimeError) else type(exc).__name__)
        return None


if __name__ == "__main__":
    main()

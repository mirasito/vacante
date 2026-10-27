import argparse
import logging
from pathlib import Path

from vacante import collect
from vacante.site import build


def main() -> None:
    parser = argparse.ArgumentParser(prog="vacante")
    sub = parser.add_subparsers(dest="command", required=True)

    p_collect = sub.add_parser("collect", help="собрать новые вакансии из источников")
    p_collect.add_argument("--config", type=Path, default=Path("config/telegram_channels.yaml"))
    p_collect.add_argument("--data-dir", type=Path, default=Path("data"))
    p_collect.add_argument("--max-age-days", type=int, default=14)

    p_build = sub.add_parser("build", help="собрать статический сайт")
    p_build.add_argument("--data-dir", type=Path, default=Path("data"))
    p_build.add_argument("--out", type=Path, default=Path("public"))
    p_build.add_argument("--base-url", default="https://vacante.kz")

    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if args.command == "collect":
        stats = collect.run(args.config, args.data_dir, args.max_age_days)
        logging.info("сбор: %s", stats)
    else:
        count = build.build(args.data_dir, args.out, args.base_url)
        logging.info("сайт: %s страниц в %s", count, args.out)


if __name__ == "__main__":
    main()

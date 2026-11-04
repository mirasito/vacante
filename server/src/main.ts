// Запуск сервера: systemd-юнит vacante-api.service (server/deploy) держит его включённым.
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { startScheduler } from "./reminder-bot.ts";
import { Bot } from "./telegram.ts";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const db = openDb(join(config.dataDir, "vacante.db"));
const bot = new Bot(config.botToken);

const server = createServer(createApp({ config, db, bot }));
// Caddy держит соединения открытыми: таймауты чуть больше, чем у него
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 60_000;
server.listen(config.port, config.host, () => {
  console.log(`vacante-api ${config.version} слушает ${config.host}:${config.port}`);
});
// Напоминания в бот: раз в 5 минут, с 9:00 до 21:00 по Казахстану и не больше двух в день
const stopReminders = startScheduler({ config, db, bot, now: Date.now, fetch });

function stop() {
  stopReminders();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

import http from 'node:http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDb, disconnectDb } from './config/db.js';
import { createApp } from './app.js';
import { initSocket } from './socket/index.js';
import { startJobs } from './jobs.js';

async function main() {
  await connectDb();
  const app = createApp();
  const server = http.createServer(app);
  const io = initSocket(server);
  const stopJobs = startJobs();

  server.listen(env.PORT, () => logger.info({ port: env.PORT, env: env.NODE_ENV }, 'HomeCare API listening'));

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down');
    stopJobs();
    io.close();
    server.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});

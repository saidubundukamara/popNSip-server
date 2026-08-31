import type { Server } from 'node:http';

import { createApp } from '@/app';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';

const app = createApp();

const server: Server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, environment: env.NODE_ENV, timezone: env.RESTAURANT_TIMEZONE },
    `popNsip API listening on ${env.API_BASE_URL}`,
  );
});

/**
 * Stop accepting connections, let in-flight requests finish, then exit. The
 * hard timeout exists because an SSE stream (Phase 5) never closes on its own.
 */
const SHUTDOWN_GRACE_MS = 10_000;
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();

  server.close((error) => {
    if (error) {
      logger.error({ err: error }, 'Error while closing the server');
      process.exit(1);
    }
    logger.info('Shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  process.exit(1);
});

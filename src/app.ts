import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { env, isProduction } from '@/config/env';
import { errorHandler, notFoundHandler } from '@/middleware/error_handler';
import { requestId } from '@/middleware/request_id';
import { routes } from '@/routes';

/**
 * Middleware order is load-bearing. Read it top to bottom:
 * correlation id first (everything downstream logs with it), then security
 * headers, then CORS, then body parsing, then routes, then the terminal
 * error handler.
 */
export function createApp(): Express {
  const app = express();

  // Behind a proxy in production: required for correct client IPs (rate
  // limiting) and for `secure` session cookies to be set at all.
  if (isProduction) app.set('trust proxy', 1);

  app.use(requestId);
  app.use(helmet());
  app.use(
    cors({
      origin: env.APP_BASE_URL,
      credentials: true, // the staff session cookie rides on cross-origin requests
    }),
  );

  // ── Webhook routers mount HERE, before express.json(), because signature
  // verification runs against the raw body (Phase 6 / Phase 7).

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  app.use(routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

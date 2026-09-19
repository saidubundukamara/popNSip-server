import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import type { RequestHandler } from 'express';
import pg from 'pg';

import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS } from '@/config/constants';
import { env, isProduction } from '@/config/env';
import { logger } from '@/lib/logger';

/**
 * Server-side sessions in Postgres (FR-AUTH-2): the cookie carries an opaque
 * id and nothing else, so signing a user out — or deactivating them — takes
 * effect immediately instead of waiting for a token to expire.
 *
 * The `session` table is created by Prisma migrations, not by this store; see
 * the Session model in schema.prisma.
 */
const PgStore = connectPgSimple(session);

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 4 });

// An idle client can be dropped from the server side (Neon suspending an idle
// compute does exactly this). Unhandled, pg re-emits that as an 'error' event
// and takes the process down; handled, the pool just replaces the client.
pool.on('error', (error) => {
  logger.warn({ err: error }, 'Session pool: idle client dropped');
});

export const sessionMiddleware: RequestHandler = session({
  name: SESSION_COOKIE_NAME,
  secret: env.SESSION_SECRET,
  store: new PgStore({ pool, tableName: 'session', createTableIfMissing: false }),
  resave: false,
  saveUninitialized: false,
  // Rolling expiry: an active shift stays signed in, an abandoned tablet does not.
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  },
});

export const closeSessionPool = (): Promise<void> => pool.end();

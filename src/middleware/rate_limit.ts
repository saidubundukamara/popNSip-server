import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { RequestHandler } from 'express';

import { isTest } from '@/config/env';
import { TooManyRequestsError } from '@/lib/errors';

/**
 * Rate limits are expressed here so the numbers are visible in one place.
 * They are disabled under NODE_ENV=test, where the point is to run assertions
 * rather than to survive them.
 */

const passthrough: RequestHandler = (_req, _res, next) => {
  next();
};

const limiter = (options: {
  windowMs: number;
  limit: number;
  keyGenerator?: (req: Parameters<RequestHandler>[0]) => string;
}): RequestHandler => {
  if (isTest) return passthrough;

  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    ...(options.keyGenerator ? { keyGenerator: options.keyGenerator } : {}),
    handler: (_req, _res, next) => {
      next(new TooManyRequestsError());
    },
  });
};

/**
 * FR-AUTH-6 asks for both: per-IP stops one machine spraying many accounts,
 * per-email stops a botnet grinding one account. Both are mounted on login.
 */
export const loginIpLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 20 });

export const loginEmailLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => {
    const email = (req.body as { email?: unknown } | undefined)?.email;
    // Fall back to the IP when there is no email to key on; ipKeyGenerator
    // normalises IPv6 so a /64 cannot be used to sidestep the limit.
    return typeof email === 'string' && email.length > 0
      ? `email:${email.toLowerCase()}`
      : ipKeyGenerator(req.ip ?? '');
  },
});

/** Public endpoints (menu, tracking) get a looser ceiling. */
export const publicApiLimiter = limiter({ windowMs: 60 * 1000, limit: 120 });

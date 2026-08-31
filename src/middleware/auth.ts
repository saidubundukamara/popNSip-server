import type { RequestHandler } from 'express';

import { roleAtLeast } from '@/config/constants';
import type { StaffRole } from '@/generated/prisma/enums';
import { ForbiddenError, UnauthorizedError } from '@/lib/errors';

/** Every staff route sits behind this. Sessions are checked server-side. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (req.isAuthenticated()) {
    next();
    return;
  }
  next(new UnauthorizedError());
};

/**
 * Minimum role, not a list of roles: OWNER passes a MANAGER guard because the
 * hierarchy lives in one helper (config/constants) rather than at every call
 * site. Implies requireAuth, so guarded routes need only one of the two.
 */
export const requireRole =
  (minimum: StaffRole): RequestHandler =>
  (req, _res, next) => {
    if (!req.isAuthenticated() || !req.user) {
      next(new UnauthorizedError());
      return;
    }
    if (!roleAtLeast(req.user.role, minimum)) {
      next(new ForbiddenError());
      return;
    }
    next();
  };

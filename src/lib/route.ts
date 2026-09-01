import type { RequestHandler } from 'express';

import { BadRequestError, NotFoundError } from '@/lib/errors';

/**
 * The three helpers every staff route needs. They lived as private copies at
 * the top of `routes/staff/orders.ts`; they are here so the routes added
 * alongside it share one definition rather than four near-identical ones.
 */

type Req = Parameters<RequestHandler>[0];
type Res = Parameters<RequestHandler>[1];

/** Wraps an async handler so a rejection reaches the terminal error middleware. */
export const handler =
  (fn: (req: Req, res: Res) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/** The signed-in staff member. `requireAuth` guarantees it; this narrows it. */
export const actorOf = (req: Req) => {
  const user = req.user;
  if (!user) throw new BadRequestError('No session.');
  return user;
};

/** A route parameter that must be present, reported as a 404 rather than a 500. */
export const requiredParam = (value: string | string[] | undefined, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new NotFoundError(`${label} not found.`);
  return value;
};

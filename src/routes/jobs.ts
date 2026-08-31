import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';

import { env } from '@/config/env';
import { NotFoundError, UnauthorizedError } from '@/lib/errors';
import { expireOrders } from '@/jobs/expire_orders';
import { reconcilePayments } from '@/jobs/reconcile_payments';

/**
 * Scheduled work, triggered over HTTP so the schedule lives with the platform
 * rather than inside a process that may be replicated.
 *
 * Guarded by CRON_SECRET rather than a staff session: a cron runner has no
 * session, and this must never be reachable by a browser that happens to be
 * signed in.
 */
export const jobsRouter: Router = Router();

const JOBS = {
  // Order matters when both are run: reconcile first, so an order with a lost
  // webhook is settled before expiry would have cancelled it.
  'reconcile-payments': reconcilePayments,
  'expire-orders': expireOrders,
} as const;

function authorise(header: string | undefined): void {
  const secret = env.CRON_SECRET;
  if (!secret) throw new UnauthorizedError('Scheduled jobs are not configured.');

  const provided = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new UnauthorizedError();
  }
}

jobsRouter.post('/api/jobs/:name', (req, res, next) => {
  try {
    authorise(req.get('authorization'));
  } catch (error) {
    next(error);
    return;
  }

  const name = req.params.name;
  const job = typeof name === 'string' ? JOBS[name as keyof typeof JOBS] : undefined;
  if (!job) {
    next(new NotFoundError(`No job named ${String(name)}.`));
    return;
  }

  job()
    .then((result) => {
      res.json({ job: name, result });
    })
    .catch(next);
});

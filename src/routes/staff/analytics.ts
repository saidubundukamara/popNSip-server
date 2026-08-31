import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { StaffRole } from '@/generated/prisma/enums';
import { BadRequestError, NotFoundError } from '@/lib/errors';
import { requireRole } from '@/middleware/auth';
import { repositories as repos } from '@/repositories';
import {
  getOrdersByHour,
  getSplits,
  getSummary,
  getTopItems,
  resolveRange,
  type DateRange,
} from '@/services/analytics_service';

/** Manager and Owner only (FR-STAT-7). */
export const staffAnalyticsRouter: Router = Router();

staffAnalyticsRouter.use('/api/staff/analytics', requireRole(StaffRole.MANAGER));

const query = z.object({
  period: z.enum(['today', '7d', '30d', 'custom']).default('today'),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const handler =
  (fn: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/** Ranges are resolved in the branch's timezone, not the caller's. */
async function contextFor(req: Parameters<RequestHandler>[0]): Promise<{
  branchId: string;
  range: DateRange;
  limit: number;
}> {
  const user = req.user;
  if (!user) throw new BadRequestError('No session.');

  const branch = await repos.branches.findById(user.branchId);
  if (!branch) throw new NotFoundError('Branch not found.');

  const parsed = query.parse(req.query);
  return {
    branchId: branch.id,
    range: resolveRange({ ...parsed, timezone: branch.timezone }),
    limit: parsed.limit,
  };
}

staffAnalyticsRouter.get(
  '/api/staff/analytics/summary',
  handler(async (req, res) => {
    const { branchId, range } = await contextFor(req);
    res.json(await getSummary(branchId, range));
  }),
);

staffAnalyticsRouter.get(
  '/api/staff/analytics/top-items',
  handler(async (req, res) => {
    const { branchId, range, limit } = await contextFor(req);
    res.json({ items: await getTopItems(branchId, range, limit), range });
  }),
);

staffAnalyticsRouter.get(
  '/api/staff/analytics/by-hour',
  handler(async (req, res) => {
    const { branchId, range } = await contextFor(req);
    res.json({ hours: await getOrdersByHour(branchId, range), range });
  }),
);

staffAnalyticsRouter.get(
  '/api/staff/analytics/splits',
  handler(async (req, res) => {
    const { branchId, range } = await contextFor(req);
    res.json({ ...(await getSplits(branchId, range)), range });
  }),
);

/** One round trip for the dashboard, which needs all four at once. */
staffAnalyticsRouter.get(
  '/api/staff/analytics/overview',
  handler(async (req, res) => {
    const { branchId, range, limit } = await contextFor(req);

    const [summary, topItems, hours, splits] = await Promise.all([
      getSummary(branchId, range),
      getTopItems(branchId, range, limit),
      getOrdersByHour(branchId, range),
      getSplits(branchId, range),
    ]);

    res.json({ summary, topItems, hours, splits, range });
  }),
);

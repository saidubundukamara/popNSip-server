import { Router } from 'express';
import { z } from 'zod';

import { actorOf, handler, requiredParam } from '@/lib/route';
import { requireAuth } from '@/middleware/auth';
import { audit } from '@/services/audit_service';
import * as menu from '@/services/menu_service';

/**
 * Marking an item sold out, and nothing else.
 *
 * The rest of `/api/staff/menu` is manager-and-above, which is right — editing
 * prices and archiving categories is not a cashier's job. But running out of
 * jollof at seven o'clock is something the person at the counter discovers,
 * and it has to come off the storefront that minute (FR-MENU-5). Routing them
 * through a manager means it stays on sale until somebody senior is free.
 *
 * So this one route sits on its own router, mounted ahead of `staffMenuRouter`
 * so its path is matched before that router's blanket role guard. Every change
 * is still audited to a named person.
 */
export const staffMenuAvailabilityRouter: Router = Router();

staffMenuAvailabilityRouter.get(
  '/api/staff/menu/availability',
  requireAuth,
  handler(async (req, res) => {
    const actor = actorOf(req);
    res.json({ categories: await menu.getAvailabilityBoard(actor.branchId) });
  }),
);

staffMenuAvailabilityRouter.patch(
  '/api/staff/menu/items/:id/availability',
  requireAuth,
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Item');
    const { isAvailable } = z.object({ isAvailable: z.boolean() }).parse(req.body);
    const { before, after } = await menu.setItemAvailability(id, isAvailable);

    await audit({
      actor,
      action: 'menu.item_availability_changed',
      targetType: 'MenuItem',
      targetId: id,
      before: { isAvailable: before.isAvailable },
      after: { isAvailable: after.isAvailable },
      requestId: req.id,
    });
    res.json({ item: after });
  }),
);

import { Router } from 'express';
import { z } from 'zod';

import { PaymentMethod, PaymentStatus, StaffRole } from '@/generated/prisma/enums';
import { actorOf, handler } from '@/lib/route';
import { requireRole } from '@/middleware/auth';
import { listPayments } from '@/services/payment_service';

/** The money that came in, and how. Manager and above. */
export const staffPaymentsRouter: Router = Router();

staffPaymentsRouter.use('/api/staff/payments', requireRole(StaffRole.MANAGER));

const listQuery = z.object({
  status: z.enum(PaymentStatus).optional(),
  method: z.enum(PaymentMethod).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  take: z.coerce.number().int().min(1).max(200).default(100),
});

staffPaymentsRouter.get(
  '/api/staff/payments',
  handler(async (req, res) => {
    const actor = actorOf(req);
    const query = listQuery.parse(req.query);

    res.json({
      payments: await listPayments({
        branchId: actor.branchId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.method ? { method: query.method } : {}),
        ...(query.from ? { from: new Date(query.from) } : {}),
        ...(query.to ? { to: new Date(query.to) } : {}),
        take: query.take,
      }),
    });
  }),
);

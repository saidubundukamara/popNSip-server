import { Router } from 'express';
import { z } from 'zod';

import { StaffRole } from '@/generated/prisma/enums';
import { handler, requiredParam } from '@/lib/route';
import { requireRole } from '@/middleware/auth';
import { getCustomer, listCustomers } from '@/services/customer_service';

/**
 * Customers (FR-CUST-3). Manager and above — a customer list is a list of
 * phone numbers and addresses, and the privacy rule applies to the people
 * reading it as much as to the logs.
 */
export const staffCustomersRouter: Router = Router();

staffCustomersRouter.use('/api/staff/customers', requireRole(StaffRole.MANAGER));

const listQuery = z.object({
  search: z.string().trim().min(1).max(60).optional(),
  take: z.coerce.number().int().min(1).max(200).default(50),
});

staffCustomersRouter.get(
  '/api/staff/customers',
  handler(async (req, res) => {
    const { search, take } = listQuery.parse(req.query);
    res.json({ customers: await listCustomers(search, take) });
  }),
);

staffCustomersRouter.get(
  '/api/staff/customers/:id',
  handler(async (req, res) => {
    const id = requiredParam(req.params.id, 'Customer');
    res.json({ customer: await getCustomer(id) });
  }),
);

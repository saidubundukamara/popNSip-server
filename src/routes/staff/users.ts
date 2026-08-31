import { Router } from 'express';
import { z } from 'zod';

import { StaffRole } from '@/generated/prisma/enums';
import { BadRequestError, NotFoundError } from '@/lib/errors';
import { requireRole } from '@/middleware/auth';
import { repositories } from '@/repositories';
import { audit, redactStaffUser } from '@/services/audit_service';
import { createStaffUser, updateStaffUser } from '@/services/auth_service';

/**
 * Staff accounts. Owner only, end to end — creating colleagues and changing
 * their roles is not a manager's job (FR-AUTH-3).
 */
export const staffUsersRouter: Router = Router();

staffUsersRouter.use('/api/staff/users', requireRole(StaffRole.OWNER));

const createSchema = z.object({
  email: z.email().transform((value) => value.toLowerCase()),
  name: z.string().trim().min(1),
  role: z.enum(StaffRole),
  password: z.string().min(12, 'Use at least 12 characters.'),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    role: z.enum(StaffRole).optional(),
    isActive: z.boolean().optional(),
    password: z.string().min(12, 'Use at least 12 characters.').optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });

staffUsersRouter.get('/api/staff/users', (req, res, next) => {
  const branchId = req.user?.branchId;
  if (!branchId) {
    next(new BadRequestError('No branch on the session.'));
    return;
  }

  repositories.staffUsers
    .findForBranch(branchId)
    .then((users) => {
      res.json({ users: users.map(redactStaffUser) });
    })
    .catch(next);
});

staffUsersRouter.post('/api/staff/users', (req, res, next) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    next(parsed.error);
    return;
  }

  const actor = req.user;
  if (!actor) {
    next(new BadRequestError('No session.'));
    return;
  }

  createStaffUser({ ...parsed.data, branchId: actor.branchId })
    .then(async (created) => {
      await audit({
        actor: { id: actor.id, role: actor.role },
        action: 'staff_user.created',
        targetType: 'StaffUser',
        targetId: created.id,
        after: redactStaffUser(created),
        requestId: req.id,
      });
      res.status(201).json({ user: redactStaffUser(created) });
    })
    .catch(next);
});

staffUsersRouter.patch('/api/staff/users/:id', (req, res, next) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    next(parsed.error);
    return;
  }

  const actor = req.user;
  const id = req.params.id;
  if (!actor || !id) {
    next(new NotFoundError('Staff account not found.'));
    return;
  }

  // An owner locking themselves out is not a recoverable mistake in v1.
  if (id === actor.id && (parsed.data.isActive === false || parsed.data.role !== undefined)) {
    next(new BadRequestError('You cannot change your own role or deactivate yourself.'));
    return;
  }

  updateStaffUser(id, parsed.data)
    .then(async ({ before, after }) => {
      await audit({
        actor: { id: actor.id, role: actor.role },
        action: 'staff_user.updated',
        targetType: 'StaffUser',
        targetId: after.id,
        before: redactStaffUser(before),
        after: redactStaffUser(after),
        requestId: req.id,
      });
      res.json({ user: redactStaffUser(after) });
    })
    .catch(next);
});

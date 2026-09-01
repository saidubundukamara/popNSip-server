import { Router } from 'express';
import { z } from 'zod';

import { StaffRole } from '@/generated/prisma/enums';
import { handler } from '@/lib/route';
import { requireRole } from '@/middleware/auth';
import { audit } from '@/services/audit_service';
import { getBranchSettings, updateBranchSettings } from '@/services/settings_service';

/**
 * Branch settings (FR-SET). Manager and above: these switches decide whether
 * the shop takes orders at all, so they are not a cashier's to flip.
 */
export const staffSettingsRouter: Router = Router();

staffSettingsRouter.use('/api/staff/settings', requireRole(StaffRole.MANAGER));

const windowSchema = z.object({
  open: z.string().regex(/^\d{1,2}:\d{2}$/, 'Use a time like 09:00.'),
  close: z.string().regex(/^\d{1,2}:\d{2}$/, 'Use a time like 22:00.'),
});

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    address: z.string().trim().min(1).max(240).optional(),
    phoneE164: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{6,14}$/, 'Use the full number with its country code, like +23277900100.')
      .optional(),
    openingHours: z
      .record(z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']), z.array(windowSchema))
      .optional(),
    // Null is meaningful and distinct from absent: it hands control back to
    // the opening hours, where false means "closed regardless".
    isOpenOverride: z.boolean().nullable().optional(),
    botEnabled: z.boolean().optional(),
    deliveryEnabled: z.boolean().optional(),
    pickupEnabled: z.boolean().optional(),
    dineInEnabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to change.' });

staffSettingsRouter.get(
  '/api/staff/settings',
  handler(async (_req, res) => {
    res.json({ settings: await getBranchSettings() });
  }),
);

staffSettingsRouter.patch(
  '/api/staff/settings',
  handler(async (req, res) => {
    const patch = patchSchema.parse(req.body);
    const before = await getBranchSettings();
    const settings = await updateBranchSettings(patch);

    // Opening and closing the shop is a money-touching decision, so it is
    // attributable like every other one (NFR: auditability).
    await audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: 'settings.updated',
      targetType: 'Branch',
      targetId: settings.id,
      before,
      after: settings,
      requestId: req.id,
    });

    res.json({ settings });
  }),
);

import { Router } from 'express';

import { authRouter } from '@/routes/auth';
import { healthRouter } from '@/routes/health';
import { publicMenuRouter } from '@/routes/public/menu';
import { publicOrdersRouter } from '@/routes/public/orders';
import { staffAnalyticsRouter } from '@/routes/staff/analytics';
import { staffCustomersRouter } from '@/routes/staff/customers';
import { staffMenuRouter } from '@/routes/staff/menu';
import { staffMenuAvailabilityRouter } from '@/routes/staff/menu_availability';
import { staffOrdersRouter } from '@/routes/staff/orders';
import { staffPaymentsRouter } from '@/routes/staff/payments';
import { staffSettingsRouter } from '@/routes/staff/settings';
import { staffUsersRouter } from '@/routes/staff/users';
import { staffWhatsAppRouter } from '@/routes/staff/whatsapp';

/**
 * Route composition root. As the phases land this gains the public menu and
 * ordering routers, the rest of the staff surface, and the webhook routers —
 * note that webhook routers must be mounted in `app.ts` ahead of the JSON body
 * parser, since signature verification needs the raw body.
 */
export const routes: Router = Router();

routes.use(healthRouter);
routes.use(authRouter);
routes.use(publicMenuRouter);
routes.use(publicOrdersRouter);
routes.use(staffAnalyticsRouter);
routes.use(staffCustomersRouter);
// Before staffMenuRouter, whose blanket manager guard would otherwise
// claim the availability path first.
routes.use(staffMenuAvailabilityRouter);
routes.use(staffMenuRouter);
routes.use(staffOrdersRouter);
routes.use(staffPaymentsRouter);
routes.use(staffSettingsRouter);
routes.use(staffUsersRouter);
routes.use(staffWhatsAppRouter);

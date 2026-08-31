import { Router } from 'express';

import { authRouter } from '@/routes/auth';
import { healthRouter } from '@/routes/health';
import { staffUsersRouter } from '@/routes/staff/users';

/**
 * Route composition root. As the phases land this gains the public menu and
 * ordering routers, the rest of the staff surface, and the webhook routers —
 * note that webhook routers must be mounted in `app.ts` ahead of the JSON body
 * parser, since signature verification needs the raw body.
 */
export const routes: Router = Router();

routes.use(healthRouter);
routes.use(authRouter);
routes.use(staffUsersRouter);

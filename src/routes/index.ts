import { Router } from 'express';

import { healthRouter } from '@/routes/health';

/**
 * Route composition root. As the phases land this gains `public/`, `staff/`
 * and `webhooks/` — note that webhook routers must be mounted in `app.ts`
 * ahead of the JSON body parser, since signature verification needs the raw
 * body.
 */
export const routes: Router = Router();

routes.use(healthRouter);

import { Router } from 'express';

import { env } from '@/config/env';

export const healthRouter: Router = Router();

/**
 * Liveness. Deliberately dependency-free: it answers "is this process up",
 * which is what a load balancer asks. A readiness probe that pings Postgres
 * arrives with the database in Phase 1.
 */
healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    environment: env.NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

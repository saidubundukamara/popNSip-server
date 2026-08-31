import { Router } from 'express';

import { env } from '@/config/env';

export const healthRouter: Router = Router();

/**
 * Liveness. Deliberately dependency-free: it answers "is this process up",
 * which is what a load balancer asks. A readiness probe that pings Postgres
 * belongs with Phase 2, where the app first holds a connection of its own.
 */
healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    environment: env.NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

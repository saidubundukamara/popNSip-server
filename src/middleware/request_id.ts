import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';

import { logger } from '@/lib/logger';

const REQUEST_ID_HEADER = 'x-request-id';

/** Accept an inbound id (proxy, load balancer) but never trust its shape. */
const sanitise = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[\w.:-]{8,128}$/.test(trimmed) ? trimmed : null;
};

/**
 * Assigns every request a correlation id and a logger bound to it, so a single
 * order's path through routes, services and upstreams can be reassembled from
 * the logs. Mount this first — everything downstream expects `req.log`.
 */
export const requestId: RequestHandler = (req, res, next) => {
  req.id = sanitise(req.headers[REQUEST_ID_HEADER]) ?? randomUUID();
  res.setHeader(REQUEST_ID_HEADER, req.id);
  req.log = logger.child({ requestId: req.id });
  next();
};

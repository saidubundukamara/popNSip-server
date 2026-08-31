import pino from 'pino';

import { env, isDevelopment, isProduction } from '@/config/env';

/**
 * Structured logging with a per-request id (see `middleware/request_id.ts`).
 *
 * FR-CUST-5: a customer phone or address must never reach the logs, and the
 * base64 `preview` on an inbound WhatsApp cart must never be written at all.
 * The redaction list below is the enforcement — extend it whenever a new shape
 * carries one of those fields, rather than remembering not to log it.
 */

const REDACTED_PATHS = [
  // credentials
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.order_token',
  '*.secret',
  '*.signature',

  // customer PII
  '*.phone',
  '*.phoneE164',
  '*.mobile',
  '*.deliveryAddress',
  '*.deliveryNotes',
  '*.lastAddress',
  '*.address',
  'customer.name',
  'order.customer.name',
  'order.deliveryAddress',

  // WhatsApp cart previews are base64 image blobs
  '*.preview',
  'message.order.preview',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  base: isProduction ? { service: 'popnsip-server' } : undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isDevelopment
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export type Logger = pino.Logger;

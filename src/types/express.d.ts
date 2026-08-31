import type { Logger } from '@/lib/logger';

declare global {
  namespace Express {
    interface Request {
      /** Correlation id for this request; echoed as the `x-request-id` header. */
      id: string;
      /** Request-scoped logger, pre-bound to `id`. */
      log: Logger;
    }
  }
}

export {};

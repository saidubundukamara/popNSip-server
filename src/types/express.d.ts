import type { StaffRole } from '@/generated/prisma/enums';
import type { Logger } from '@/lib/logger';

declare global {
  namespace Express {
    /**
     * What passport puts on `req.user`. Deliberately not the full StaffUser —
     * `passwordHash` must never be one property access away from a response.
     */
    interface User {
      id: string;
      branchId: string;
      email: string;
      name: string;
      role: StaffRole;
    }

    interface Request {
      /** Correlation id for this request; echoed as the `x-request-id` header. */
      id: string;
      /** Request-scoped logger, pre-bound to `id`. */
      log: Logger;
    }
  }
}

export {};

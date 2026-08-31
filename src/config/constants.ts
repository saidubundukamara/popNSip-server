import { StaffRole } from '@/generated/prisma/enums';

/** Session cookie name. Also what web/'s middleware looks for. */
export const SESSION_COOKIE_NAME = 'popnsip.sid';

/** 12 hours, rolling — a shift outlasts it only if nobody touches the tablet. */
export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * OWNER > MANAGER > STAFF. The hierarchy lives here and nowhere else, so a
 * route asks for a minimum role rather than listing every role that qualifies.
 */
const ROLE_RANK: Record<StaffRole, number> = {
  [StaffRole.STAFF]: 1,
  [StaffRole.MANAGER]: 2,
  [StaffRole.OWNER]: 3,
};

export const roleAtLeast = (role: StaffRole, minimum: StaffRole): boolean =>
  ROLE_RANK[role] >= ROLE_RANK[minimum];

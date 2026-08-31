import { randomUUID } from 'node:crypto';

import argon2 from 'argon2';

import type { StaffRole } from '@/generated/prisma/enums';
import type { StaffUserModel } from '@/generated/prisma/models';
import { ConflictError, NotFoundError, UnauthorizedError } from '@/lib/errors';
import { repositories } from '@/repositories';

/**
 * Credentials and staff accounts. Passport calls into `validateCredentials`;
 * everything else here backs the owner-only /api/staff/users routes.
 */

/** What passport stores on the session. Never the password hash. */
export type SessionUser = {
  id: string;
  branchId: string;
  email: string;
  name: string;
  role: StaffRole;
};

export const toSessionUser = (user: StaffUserModel): SessionUser => ({
  id: user.id,
  branchId: user.branchId,
  email: user.email,
  name: user.name,
  role: user.role,
});

const hashPassword = (plain: string): Promise<string> => argon2.hash(plain);

/**
 * A wrong email and a wrong password fail identically, and both do the same
 * amount of work — otherwise response timing tells an attacker which emails
 * exist.
 */
const dummyHash = argon2.hash(randomUUID());

export async function validateCredentials(email: string, password: string): Promise<SessionUser | null> {
  const user = await repositories.staffUsers.findByEmail(email);

  if (!user) {
    // Real verify against a real hash: a cheap comparison here would make an
    // unknown email measurably faster to reject than a wrong password.
    await argon2.verify(await dummyHash, password).catch(() => false);
    return null;
  }

  const passwordMatches = await argon2.verify(user.passwordHash, password).catch(() => false);
  if (!passwordMatches) return null;

  // Deactivation must lock a user out even with the right password (FR-AUTH-5).
  if (!user.isActive) return null;

  return toSessionUser(user);
}

/**
 * Re-read on every request via passport's deserializeUser. This is what makes
 * deactivation revoke a live session rather than waiting for it to expire.
 */
export async function loadActiveUser(id: string): Promise<SessionUser | null> {
  const user = await repositories.staffUsers.findById(id);
  if (!user || !user.isActive) return null;
  return toSessionUser(user);
}

export async function recordLogin(id: string): Promise<void> {
  await repositories.staffUsers.update(id, { lastLoginAt: new Date() });
}

export async function createStaffUser(input: {
  branchId: string;
  email: string;
  name: string;
  role: StaffRole;
  password: string;
}): Promise<StaffUserModel> {
  const email = input.email.toLowerCase();
  if (await repositories.staffUsers.findByEmail(email)) {
    throw new ConflictError('A staff account with that email already exists.');
  }

  return repositories.staffUsers.create({
    branchId: input.branchId,
    email,
    name: input.name,
    role: input.role,
    passwordHash: await hashPassword(input.password),
  });
}

export async function updateStaffUser(
  id: string,
  changes: { name?: string; role?: StaffRole; isActive?: boolean; password?: string },
): Promise<{ before: StaffUserModel; after: StaffUserModel }> {
  const before = await repositories.staffUsers.findById(id);
  if (!before) throw new NotFoundError('Staff account not found.');

  const { password, ...rest } = changes;
  const after = await repositories.staffUsers.update(id, {
    ...rest,
    ...(password ? { passwordHash: await hashPassword(password) } : {}),
  });

  return { before, after };
}

export async function changeOwnPassword(id: string, currentPassword: string, newPassword: string): Promise<void> {
  const user = await repositories.staffUsers.findById(id);
  if (!user) throw new NotFoundError('Staff account not found.');

  const matches = await argon2.verify(user.passwordHash, currentPassword).catch(() => false);
  if (!matches) throw new UnauthorizedError('Current password is incorrect.');

  await repositories.staffUsers.update(id, { passwordHash: await hashPassword(newPassword) });
}

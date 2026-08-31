import type { TxClient } from '@/repositories/base.repository';
import { repositories } from '@/repositories';
import { logger } from '@/lib/logger';

/**
 * The trail for money-touching and destructive staff actions (FR-AUTH-7).
 *
 * Auditing must never be the reason an operation fails: if the write throws,
 * we log loudly and let the caller carry on. Pass a transaction client when
 * the audit row should live or die with the change it describes.
 */

export type AuditActor = { id: string; role: string } | 'system';

export type AuditInput = {
  actor: AuditActor;
  action: string;
  targetType: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  requestId?: string;
};

export async function audit(input: AuditInput, tx?: TxClient): Promise<void> {
  const repo = tx ? repositories.audit.withTx(tx) : repositories.audit;

  try {
    await repo.create({
      staffUserId: input.actor === 'system' ? null : input.actor.id,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      before: (input.before ?? null) as never,
      after: (input.after ?? null) as never,
      requestId: input.requestId ?? null,
    });
  } catch (error) {
    logger.error({ err: error, action: input.action, targetType: input.targetType }, 'Failed to write audit log');
  }
}

/** Drop the fields an audit row should never carry. */
export const redactStaffUser = <T extends { passwordHash?: string }>(user: T): Omit<T, 'passwordHash'> => {
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
};

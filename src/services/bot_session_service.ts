import { AsyncLocalStorage } from 'node:async_hooks';

import type { WhatsAppConversationModel } from '@/generated/prisma/models';
import { logger } from '@/lib/logger';
import { repositories as repos } from '@/repositories';

/**
 * The bot's session, and the accumulator that keeps it to one write.
 *
 * Lifted from byn2_v2's `BotSessionAccumulator`, which is the good idea in
 * that codebase: a handler chain touches the session half a dozen times while
 * deciding what to say, and without this each touch is its own UPDATE. The
 * accumulator batches them into a single write at the end of the message.
 *
 * AsyncLocalStorage rather than a module-level variable, so two customers
 * messaging at the same instant cannot write into each other's session.
 */

export type BotIntent =
  | 'start'
  | 'cart_review'
  | 'configure_item'
  | 'order_type'
  | 'address'
  | 'payment'
  | 'browse'
  | 'human';

export type SessionChanges = {
  intent?: BotIntent | null;
  step?: string | null;
  metadata?: Record<string, unknown>;
  needsHuman?: boolean;
  lastInboundAt?: Date;
  expiresAt?: Date | null;
  customerId?: string | null;
};

/** 30 minutes of inactivity, matching `expiresAt` on the row. */
export const SESSION_TTL_MS = 30 * 60 * 1000;

export const sessionExpiryFrom = (at: Date): Date => new Date(at.getTime() + SESSION_TTL_MS);

export class BotSessionAccumulator {
  private changes: SessionChanges = {};

  constructor(
    readonly sessionId: string,
    private readonly initialMetadata: Record<string, unknown> = {},
  ) {}

  /** Queue a change. Nothing is written until `commit`. */
  set(changes: SessionChanges): void {
    if (changes.metadata) {
      // Metadata merges rather than replaces: two handlers in one message each
      // add a key, and neither should erase the other's.
      const { metadata, ...rest } = changes;
      this.changes = {
        ...this.changes,
        ...rest,
        metadata: { ...this.metadata(), ...metadata },
      };
      return;
    }
    this.changes = { ...this.changes, ...changes };
  }

  /** Metadata as it stands, including anything queued this message. */
  metadata(): Record<string, unknown> {
    return { ...this.initialMetadata, ...(this.changes.metadata ?? {}) };
  }

  read<T>(key: string): T | undefined {
    return this.metadata()[key] as T | undefined;
  }

  hasChanges(): boolean {
    return Object.keys(this.changes).length > 0;
  }

  async commit(): Promise<void> {
    if (!this.hasChanges()) return;

    const { metadata, ...rest } = this.changes;
    await repos.conversations.update(this.sessionId, {
      ...rest,
      ...(metadata ? { metadata: metadata as never } : {}),
    });
    this.changes = {};
  }
}

const storage = new AsyncLocalStorage<BotSessionAccumulator>();

export const currentAccumulator = (): BotSessionAccumulator | undefined => storage.getStore();

/**
 * Run a handler with an accumulator in scope, then flush it.
 *
 * The flush happens even when the handler throws: the customer has already
 * been sent whatever the handler managed to send, and a session left at the
 * previous step would ask them the same question again.
 */
export async function withSession<T>(
  accumulator: BotSessionAccumulator,
  handler: () => Promise<T>,
): Promise<T> {
  return storage.run(accumulator, async () => {
    try {
      return await handler();
    } finally {
      await accumulator.commit().catch((error: unknown) => {
        logger.error({ err: error, sessionId: accumulator.sessionId }, 'Could not save the bot session');
      });
    }
  });
}

/** Queue a session change from anywhere inside `withSession`. */
export function updateSession(changes: SessionChanges): void {
  const accumulator = currentAccumulator();
  if (!accumulator) {
    logger.warn('updateSession called outside a session context; change dropped');
    return;
  }
  accumulator.set(changes);
}

export const sessionMetadata = (): Record<string, unknown> => currentAccumulator()?.metadata() ?? {};

/**
 * The live session for a number, or a fresh one.
 *
 * An expired session is not reused: coming back an hour later should start a
 * new conversation, not resume a half-answered address question.
 */
export async function resolveSession(
  phoneE164: string,
  now: Date = new Date(),
): Promise<WhatsAppConversationModel> {
  const active = await repos.conversations.findActiveByPhone(phoneE164, now);
  if (active) return active;

  const customer = await repos.customers.findByPhone(phoneE164);

  return repos.conversations.create({
    phoneE164,
    customerId: customer?.id ?? null,
    intent: 'start',
    step: null,
    metadata: {},
    lastInboundAt: now,
    expiresAt: sessionExpiryFrom(now),
  });
}

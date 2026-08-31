import { prisma } from '@/db/client';
import { ActorType, OrderStatus, OrderType } from '@/generated/prisma/enums';
import type { OrderModel } from '@/generated/prisma/models';
import { ForbiddenError, IllegalTransitionError, NotFoundError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { repositories as repos } from '@/repositories';
import { emit } from '@/services/sse_service';
import { notifyOrderStatus } from '@/services/wa_notification_service';
import type { TxClient } from '@/repositories/base.repository';

/**
 * The order state machine (PRD §7). Every status change in the product goes
 * through `transition` — no route, service or job sets `status` directly.
 *
 * The rules are data, not branches. A table can be read against the PRD in one
 * sitting; a chain of `if` statements cannot, and quietly grows a path nobody
 * intended.
 */

type Rule = {
  to: OrderStatus;
  /** Who may cause it. SYSTEM means payment verification, never a person. */
  actors: ActorType[];
  /** When present, the transition applies only to these order types. */
  orderTypes?: OrderType[];
  /** Manager or above (checked by the caller, which knows the staff role). */
  requiresManager?: boolean;
  /** Refuse without a stated reason. */
  requiresReason?: boolean;
};

const STAFF_OR_SYSTEM = [ActorType.STAFF, ActorType.SYSTEM];

export const TRANSITIONS: Record<OrderStatus, Rule[]> = {
  [OrderStatus.DRAFT]: [
    { to: OrderStatus.CONFIRMED, actors: [ActorType.STAFF] },
    { to: OrderStatus.AWAITING_PAYMENT, actors: [ActorType.STAFF] },
    { to: OrderStatus.CANCELLED, actors: STAFF_OR_SYSTEM },
  ],

  // Only the system may move an order out of AWAITING_PAYMENT on the basis of
  // payment. Staff may cancel it, but they may not declare it paid.
  [OrderStatus.AWAITING_PAYMENT]: [
    { to: OrderStatus.CONFIRMED, actors: [ActorType.SYSTEM] },
    { to: OrderStatus.CANCELLED, actors: STAFF_OR_SYSTEM },
  ],

  [OrderStatus.PENDING_CONFIRMATION]: [
    { to: OrderStatus.CONFIRMED, actors: [ActorType.STAFF] },
    { to: OrderStatus.CANCELLED, actors: STAFF_OR_SYSTEM, requiresReason: true },
  ],

  [OrderStatus.CONFIRMED]: [
    { to: OrderStatus.PREPARING, actors: [ActorType.STAFF] },
    { to: OrderStatus.CANCELLED, actors: [ActorType.STAFF], requiresManager: true, requiresReason: true },
  ],

  [OrderStatus.PREPARING]: [
    { to: OrderStatus.READY, actors: [ActorType.STAFF] },
    { to: OrderStatus.CANCELLED, actors: [ActorType.STAFF], requiresManager: true, requiresReason: true },
  ],

  [OrderStatus.READY]: [
    { to: OrderStatus.OUT_FOR_DELIVERY, actors: [ActorType.STAFF], orderTypes: [OrderType.DELIVERY] },
    { to: OrderStatus.SERVED, actors: [ActorType.STAFF], orderTypes: [OrderType.DINE_IN] },
    { to: OrderStatus.COMPLETED, actors: [ActorType.STAFF], orderTypes: [OrderType.PICKUP, OrderType.WALK_IN] },
    { to: OrderStatus.CANCELLED, actors: [ActorType.STAFF], requiresManager: true, requiresReason: true },
  ],

  [OrderStatus.OUT_FOR_DELIVERY]: [
    { to: OrderStatus.COMPLETED, actors: [ActorType.STAFF] },
    { to: OrderStatus.CANCELLED, actors: [ActorType.STAFF], requiresManager: true, requiresReason: true },
  ],

  [OrderStatus.SERVED]: [
    { to: OrderStatus.COMPLETED, actors: [ActorType.STAFF] },
    { to: OrderStatus.CANCELLED, actors: [ActorType.STAFF], requiresManager: true, requiresReason: true },
  ],

  // Terminal, except for the refund path.
  [OrderStatus.COMPLETED]: [
    { to: OrderStatus.REFUNDED, actors: [ActorType.STAFF], requiresManager: true, requiresReason: true },
  ],
  [OrderStatus.CANCELLED]: [
    { to: OrderStatus.REFUNDED, actors: [ActorType.STAFF], requiresManager: true, requiresReason: true },
  ],
  [OrderStatus.REFUNDED]: [],
};

export const TERMINAL_STATUSES = [OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.REFUNDED] as const;

export type TransitionActor =
  | { type: typeof ActorType.STAFF; staffId: string; isManager: boolean }
  | { type: typeof ActorType.CUSTOMER; customerId?: string }
  | { type: typeof ActorType.SYSTEM };

export function findRule(from: OrderStatus, to: OrderStatus, orderType: OrderType): Rule | null {
  const rule = TRANSITIONS[from].find(
    (candidate) =>
      candidate.to === to && (!candidate.orderTypes || candidate.orderTypes.includes(orderType)),
  );
  return rule ?? null;
}

/** What the POS should offer as one-tap actions for this order. */
export function allowedTransitions(from: OrderStatus, orderType: OrderType): OrderStatus[] {
  return TRANSITIONS[from]
    .filter((rule) => !rule.orderTypes || rule.orderTypes.includes(orderType))
    .map((rule) => rule.to);
}

/**
 * Assert a transition is legal, without performing it. Exported so the state
 * machine can be tested without a database, and so callers can check before
 * offering an action.
 */
export function assertTransitionAllowed(input: {
  from: OrderStatus;
  to: OrderStatus;
  orderType: OrderType;
  actor: TransitionActor;
  reason?: string | undefined;
}): Rule {
  const { from, to, orderType, actor, reason } = input;

  if (from === to) throw new IllegalTransitionError(from, to, 'The order is already in that state.');

  const rule = findRule(from, to, orderType);
  if (!rule) throw new IllegalTransitionError(from, to);

  if (!rule.actors.includes(actor.type)) {
    throw new ForbiddenError(
      actor.type === ActorType.STAFF && rule.actors.includes(ActorType.SYSTEM)
        ? 'Only a verified payment can move this order forward.'
        : 'You cannot make that change.',
    );
  }

  if (rule.requiresManager && actor.type === ActorType.STAFF && !actor.isManager) {
    throw new ForbiddenError('A manager must approve this.');
  }

  if (rule.requiresReason && !reason?.trim()) {
    throw new ValidationError('A reason is required.', [{ path: 'reason', message: 'Say why.' }]);
  }

  return rule;
}

export type TransitionResult = { order: OrderModel; from: OrderStatus };

/**
 * Perform a transition.
 *
 * Inside the transaction: check legality against the row as it is now, write
 * the status and the history event. After it commits: emit SSE and queue the
 * WhatsApp message. Never the reverse — a notification for a write that then
 * rolls back is worse than a late notification.
 */
export async function transition(input: {
  orderId: string;
  to: OrderStatus;
  actor: TransitionActor;
  reason?: string | undefined;
  /** Applied inside the same transaction as the status change. */
  extraData?: Record<string, unknown>;
}): Promise<TransitionResult> {
  const { orderId, to, actor, reason } = input;

  const result = await prisma.$transaction(async (tx: TxClient) => {
    // Re-read inside the transaction: two staff tapping the same order at once
    // must not both pass a check made against a stale status.
    const order = await repos.orders.withTx(tx).findById(orderId);
    if (!order) throw new NotFoundError('Order not found.');

    assertTransitionAllowed({ from: order.status, to, orderType: order.type, actor, reason });

    const now = new Date();
    const updated = await repos.orders.withTx(tx).update(orderId, {
      status: to,
      ...(to === OrderStatus.COMPLETED ? { completedAt: now } : {}),
      ...(to === OrderStatus.CANCELLED ? { cancelledAt: now, cancelReason: reason ?? null } : {}),
      ...(input.extraData ?? {}),
    });

    await repos.statusEvents.withTx(tx).create({
      orderId,
      fromStatus: order.status,
      toStatus: to,
      actorType: actor.type,
      actorStaffId: actor.type === ActorType.STAFF ? actor.staffId : null,
      reason: reason ?? null,
    });

    // Customer totals count completed orders only, matching PRD §11's rule
    // that revenue is COMPLETED. Counting at creation would credit an order
    // that is later cancelled.
    if (to === OrderStatus.COMPLETED && order.customerId) {
      await tx.customer.update({
        where: { id: order.customerId },
        data: {
          orderCount: { increment: 1 },
          lifetimeSpendMinor: { increment: updated.totalMinor },
        },
      });
    }

    return { order: updated, from: order.status };
  });

  // ── after commit ──
  // The transaction has landed, so a subscriber that acts on this event will
  // find the change already there. Emitting inside the transaction would
  // announce a write that might still roll back.
  emit(result.order.branchId, {
    name: 'order.status_changed',
    data: {
      orderId,
      reference: result.order.reference,
      from: result.from,
      to,
      at: new Date().toISOString(),
    },
  });

  // Queued, not sent (FR-WA-8): the order has already moved, and a slow or
  // failed WhatsApp send must not undo that or make the caller wait for it.
  await notifyOrderStatus({
    id: result.order.id,
    reference: result.order.reference,
    status: to,
    type: result.order.type,
    trackingToken: result.order.trackingToken,
    customerId: result.order.customerId,
  }).catch((error: unknown) => {
    logger.error({ err: error, orderId }, 'Could not queue the customer notification');
  });

  logger.info({ orderId, from: result.from, to, actorType: actor.type }, 'Order status changed');

  return result;
}

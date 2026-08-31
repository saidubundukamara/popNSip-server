import { prisma } from '@/db/client';
import { ActorType, OrderStatus, PaymentStatus } from '@/generated/prisma/enums';
import { NotFoundError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { resolveOwnerId, sumFees, type MonimeWebhookPayload } from '@/lib/monime';
import { repositories as repos } from '@/repositories';
import {
  findMobileMoneyPayment,
  markPaymentFailed,
  settleMobileMoneyPayment,
} from '@/services/payment_service';
import { transition } from '@/services/order_status_service';

/**
 * What a Monime webhook actually does to an order.
 *
 * Three things byn2_v2's integration lacks and this one must not: the
 * signature is verified (in the route, against the raw body), the delivery is
 * claimed so a replay credits once, and a payment that never produces a
 * webhook is caught by reconciliation.
 */

/**
 * Names seen across two working integrations. Payment codes emit the
 * `payment_code.*` family; the settlement event captured from live traffic is
 * `payment.processing_completed` — `payment.completed` is assumed by some
 * integrations and may never fire. Both are handled, and the handler is the
 * same either way, so whichever arrives settles the order once.
 */
const SETTLED_EVENTS = new Set([
  'payment_code.completed',
  'payment.processing_completed',
  'payment.completed',
]);

const FAILED_EVENTS = new Set(['payment_code.failed', 'payment.failed']);
const EXPIRED_EVENTS = new Set(['payment_code.expired', 'payment_code.cancelled']);
/** Informational: money is moving but has not landed. */
const PROGRESS_EVENTS = new Set(['payment_code.processed', 'payment.processing', 'payment_code.pending']);

export type WebhookOutcome =
  | { handled: true; effect: 'settled' | 'failed' | 'expired' | 'progress' | 'already_settled' }
  | { handled: false; reason: string };

/**
 * Find the order a webhook is about.
 *
 * `reference` is our own order id, echoed back — that is the whole point of
 * setting it, and it means a webhook finds its row without a lookup table. The
 * ownership graph and payment provider ref are fallbacks for events that carry
 * no reference of their own.
 */
async function resolveOrder(payload: MonimeWebhookPayload) {
  const reference = payload.data?.reference;
  if (reference) {
    const byReference = await repos.orders.findById(reference);
    if (byReference) return byReference;
  }

  const providerRef = resolveOwnerId(payload.data) ?? payload.object?.id;
  if (providerRef) {
    const payment = await repos.payments.findByProviderRef('monime', providerRef);
    if (payment) return repos.orders.findById(payment.orderId);
  }

  return null;
}

export async function handleMonimeEvent(payload: MonimeWebhookPayload): Promise<WebhookOutcome> {
  const name = payload.event.name;

  if (PROGRESS_EVENTS.has(name)) {
    logger.info({ event: name }, 'Monime payment in progress');
    return { handled: true, effect: 'progress' };
  }

  if (!SETTLED_EVENTS.has(name) && !FAILED_EVENTS.has(name) && !EXPIRED_EVENTS.has(name)) {
    // warn, not info: an event type quietly accepted at info level is exactly
    // how a whole class of them goes unnoticed in production.
    logger.warn({ event: name, eventId: payload.event.id }, 'Unhandled Monime webhook event');
    return { handled: false, reason: `unhandled event ${name}` };
  }

  const order = await resolveOrder(payload);
  if (!order) {
    // Not a 500: an event for an order we do not have is understood and
    // irrelevant, and telling Monime to retry it forever helps nobody.
    logger.warn({ event: name, eventId: payload.event.id }, 'Monime event for an unknown order');
    return { handled: false, reason: 'unknown order' };
  }

  const payment = await findMobileMoneyPayment(order.id, resolveOwnerId(payload.data));

  if (SETTLED_EVENTS.has(name)) return settle(order.id, payment?.id, payload);
  if (FAILED_EVENTS.has(name)) {
    if (payment) await markPaymentFailed(payment.id, PaymentStatus.FAILED, payload.data);
    return { handled: true, effect: 'failed' };
  }

  if (payment) await markPaymentFailed(payment.id, PaymentStatus.EXPIRED, payload.data);
  return { handled: true, effect: 'expired' };
}

/**
 * Settle a payment and move the order forward.
 *
 * Two events can describe one payment and either may arrive first, so this is
 * written to be safe to run twice: the second run finds the payment already
 * SUCCEEDED and stops before transitioning again.
 */
async function settle(
  orderId: string,
  paymentId: string | undefined,
  payload: MonimeWebhookPayload,
): Promise<WebhookOutcome> {
  const feeMinor = sumFees(payload.data?.fees);
  const paidMinor = payload.data?.amount?.value;

  const settled = await prisma.$transaction(async (tx) => {
    const order = await repos.orders.withTx(tx).findById(orderId);
    if (!order) throw new NotFoundError('Order not found.');

    if (!paymentId) return true;

    const payment = await repos.payments.withTx(tx).findById(paymentId);

    if (payment?.status === PaymentStatus.SUCCEEDED) {
      // The sibling event. It must not credit again — but if this is the one
      // carrying fees, its payload is the fuller record and worth keeping.
      if (feeMinor !== null) {
        await repos.payments.withTx(tx).update(paymentId, { rawPayload: payload.data as never });
      }
      return false;
    }

    await settleMobileMoneyPayment({
      paymentId,
      ...(typeof paidMinor === 'number' ? { amountMinor: paidMinor } : {}),
      raw: payload.data,
      tx,
    });

    return true;
  });

  if (feeMinor !== null) {
    // Not modelled in v1 — the restaurant is credited the gross and the fee is
    // Monime's cut — but it is recorded so the figure exists when it matters.
    logger.info({ orderId, feeMinor }, 'Monime reported a provider fee');
  }

  if (!settled) {
    logger.info({ orderId }, 'Monime settlement event for an already-settled payment');
    return { handled: true, effect: 'already_settled' };
  }

  const order = await repos.orders.findById(orderId);
  if (!order) return { handled: false, reason: 'order vanished mid-settlement' };

  // FR-PAY-8: a payment that lands after the order was auto-cancelled is
  // flagged for a human, never silently resurrected and never silently
  // ignored — the customer has been debited either way.
  if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REFUNDED) {
    await repos.orders.update(orderId, { needsReview: true });
    logger.warn({ orderId, status: order.status }, 'Payment confirmed after the order was closed');
    return { handled: true, effect: 'settled' };
  }

  if (order.status === OrderStatus.AWAITING_PAYMENT) {
    // SYSTEM, never a person: PRD §7.2 lets only a verified payment move an
    // order out of AWAITING_PAYMENT.
    await transition({ orderId, to: OrderStatus.CONFIRMED, actor: { type: ActorType.SYSTEM } });
  }

  return { handled: true, effect: 'settled' };
}

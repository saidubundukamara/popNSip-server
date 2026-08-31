import { ActorType, OrderStatus, PaymentStatus } from '@/generated/prisma/enums';
import { logger } from '@/lib/logger';
import { getPaymentCode, isMonimeConfigured } from '@/lib/monime';
import { repositories as repos } from '@/repositories';
import { transition } from '@/services/order_status_service';
import { markPaymentFailed, settleMobileMoneyPayment } from '@/services/payment_service';

/**
 * The safety net for a webhook that never arrived (FR-PAY-7).
 *
 * A lost webhook otherwise leaves a paid order stuck in AWAITING_PAYMENT
 * forever, which is the single worst failure this system can have: the
 * customer has been debited and the kitchen never hears about it.
 *
 * Note that a polled read carries no fee data — anything settled this way
 * records the gross without the provider's cut. That is logged where it
 * happens rather than left to be discovered in a reconciliation spreadsheet.
 */

/** Give the webhook a fair chance before going behind its back. */
const MIN_AGE_MS = 2 * 60 * 1000;

export type ReconcileResult = {
  checked: number;
  settled: number;
  expired: number;
  flagged: number;
  failed: number;
};

/** Monime's own words for "the money arrived". */
const SETTLED_STATUSES = new Set(['completed', 'success', 'succeeded', 'paid']);
const DEAD_STATUSES = new Set(['expired', 'cancelled', 'failed']);

export async function reconcilePayments(now: Date = new Date()): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, settled: 0, expired: 0, flagged: 0, failed: 0 };

  if (!isMonimeConfigured()) {
    logger.debug('Skipping payment reconciliation: Monime is not configured');
    return result;
  }

  const cutoff = new Date(now.getTime() - MIN_AGE_MS);
  const orders = await repos.orders.findAwaitingPaymentOlderThan(cutoff);

  for (const order of orders) {
    const pending = order.payments.find(
      (payment) => payment.status === PaymentStatus.PENDING && payment.providerRef,
    );
    if (!pending?.providerRef) continue;

    result.checked += 1;

    try {
      const remote = await getPaymentCode(pending.providerRef);
      const status = String(remote.status ?? '').toLowerCase();

      if (SETTLED_STATUSES.has(status)) {
        await settleMobileMoneyPayment({ paymentId: pending.id, raw: remote });

        // Re-read: the webhook may have landed while this loop was running.
        const fresh = await repos.orders.findById(order.id);
        if (fresh?.status === OrderStatus.AWAITING_PAYMENT) {
          await transition({ orderId: order.id, to: OrderStatus.CONFIRMED, actor: { type: ActorType.SYSTEM } });
        }

        logger.warn(
          { orderId: order.id, paymentId: pending.id },
          'Settled by reconciliation, not a webhook — no provider fee was reported',
        );
        result.settled += 1;
        continue;
      }

      if (DEAD_STATUSES.has(status)) {
        await markPaymentFailed(pending.id, PaymentStatus.EXPIRED, remote);
        result.expired += 1;
      }
    } catch (error) {
      // One unreachable payment must not stop the sweep.
      result.failed += 1;
      logger.error({ err: error, orderId: order.id, paymentId: pending.id }, 'Reconciliation check failed');
    }
  }

  logger.info(result, 'Payment reconciliation finished');
  return result;
}

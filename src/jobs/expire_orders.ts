import { ActorType, OrderStatus } from '@/generated/prisma/enums';
import { logger } from '@/lib/logger';
import { repositories as repos } from '@/repositories';
import { transition } from '@/services/order_status_service';

/**
 * Cancel unpaid orders past their hold.
 *
 * Runs *after* reconciliation, never instead of it: cancelling an order whose
 * payment simply had a lost webhook is how a paying customer gets told their
 * order was dropped.
 */
export async function expireOrders(now: Date = new Date()): Promise<{ cancelled: number }> {
  const stale = await repos.orders.findExpiredAwaitingPayment(now);
  let cancelled = 0;

  for (const order of stale) {
    // A settled payment against an expiring order means reconciliation has not
    // caught up yet. Leave it; the next sweep will confirm it.
    const settled = await repos.payments.sumSettledForOrder(order.id);
    if (settled > 0) {
      logger.warn({ orderId: order.id }, 'Skipping expiry: the order has a settled payment');
      continue;
    }

    try {
      await transition({
        orderId: order.id,
        to: OrderStatus.CANCELLED,
        actor: { type: ActorType.SYSTEM },
        reason: 'Payment was not completed in time.',
      });
      cancelled += 1;
    } catch (error) {
      logger.error({ err: error, orderId: order.id }, 'Could not expire an unpaid order');
    }
  }

  if (cancelled > 0) logger.info({ cancelled }, 'Expired unpaid orders');
  return { cancelled };
}

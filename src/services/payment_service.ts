import { prisma } from '@/db/client';
import { OrderStatus, PaymentMethod, PaymentStatus } from '@/generated/prisma/enums';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { sumMinor } from '@/lib/money';
import { repositories as repos } from '@/repositories';
import type { TxClient } from '@/repositories/base.repository';

/**
 * Payments. Cash is settled here; Monime arrives in Phase 6 and will create
 * its Payment row PENDING before it calls out (FR-PAY-3).
 */

/** What the order still owes: total, less everything actually settled. */
export async function balanceFor(orderId: string): Promise<{ totalMinor: number; settledMinor: number; balanceDueMinor: number }> {
  const order = await repos.orders.findById(orderId);
  if (!order) throw new NotFoundError('Order not found.');

  const settledMinor = await repos.payments.sumSettledForOrder(orderId);
  return { totalMinor: order.totalMinor, settledMinor, balanceDueMinor: sumMinor(order.totalMinor, -settledMinor) };
}

/**
 * Record cash taken at the counter or on delivery (FR-PAY-7, FR-PAY-9).
 *
 * Change is computed rather than accepted from the client: the amount that
 * settles the order is the amount owed, and what the customer handed over is
 * recorded separately so the drawer can be reconciled.
 */
export async function recordCashPayment(input: {
  orderId: string;
  amountMinor: number;
  tenderedMinor?: number | undefined;
  staffId: string;
}) {
  const { orderId, amountMinor, tenderedMinor, staffId } = input;

  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new ValidationError('Enter an amount to record.', [
      { path: 'amountMinor', message: 'Must be more than zero.' },
    ]);
  }

  if (tenderedMinor !== undefined && tenderedMinor < amountMinor) {
    throw new ValidationError('The amount tendered is less than the amount being recorded.', [
      { path: 'tenderedMinor', message: 'Tendered must cover the payment.' },
    ]);
  }

  return prisma.$transaction(async (tx: TxClient) => {
    const order = await repos.orders.withTx(tx).findById(orderId);
    if (!order) throw new NotFoundError('Order not found.');

    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REFUNDED) {
      throw new ConflictError('That order is closed.');
    }

    const alreadySettled = await repos.payments.withTx(tx).sumSettledForOrder(orderId);
    const outstanding = sumMinor(order.totalMinor, -alreadySettled);

    if (amountMinor > outstanding) {
      throw new ValidationError('That is more than the order still owes.', [
        { path: 'amountMinor', message: `Outstanding is ${outstanding} minor units.` },
      ]);
    }

    const payment = await repos.payments.withTx(tx).create({
      orderId,
      method: PaymentMethod.CASH,
      status: PaymentStatus.SUCCEEDED,
      amountMinor,
      tenderedMinor: tenderedMinor ?? null,
      changeMinor: tenderedMinor === undefined ? null : tenderedMinor - amountMinor,
      recordedByStaffId: staffId,
      settledAt: new Date(),
    });

    return {
      payment,
      changeMinor: payment.changeMinor ?? 0,
      balanceDueMinor: sumMinor(outstanding, -amountMinor),
    };
  });
}

/**
 * Refunds are recorded, not executed (FR-PAY-10). The money moves outside the
 * system; this row is the record that it did.
 */
export async function recordRefund(input: {
  orderId: string;
  amountMinor: number;
  staffId: string;
}) {
  const { orderId, amountMinor, staffId } = input;

  const settled = await repos.payments.sumSettledForOrder(orderId);
  if (amountMinor > settled) {
    throw new ValidationError('You cannot refund more than was taken.', [
      { path: 'amountMinor', message: `At most ${settled} minor units.` },
    ]);
  }

  return repos.payments.create({
    orderId,
    method: PaymentMethod.CASH,
    status: PaymentStatus.REFUNDED,
    amountMinor: -amountMinor,
    recordedByStaffId: staffId,
    settledAt: new Date(),
  });
}

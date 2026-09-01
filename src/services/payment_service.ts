import { prisma } from '@/db/client';
import { OrderStatus, PaymentMethod, PaymentStatus } from '@/generated/prisma/enums';
import type { PaymentModel } from '@/generated/prisma/models';
import { ConflictError, NotFoundError, UpstreamError, ValidationError } from '@/lib/errors';
import { createPaymentCode, isMonimeConfigured } from '@/lib/monime';
import { sumMinor } from '@/lib/money';
import { repositories as repos } from '@/repositories';
import type { TxClient } from '@/repositories/base.repository';

/**
 * Payments: cash taken at the counter, and mobile money through Monime.
 */

export const MONIME_PROVIDER = 'monime';

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


// ─── mobile money ─────────────────────────────────────────────────────────

export type MobileMoneyPayment = {
  payment: PaymentModel;
  ussdCode: string | null;
  amountMinor: number;
};

/**
 * Start a Monime payment for an order.
 *
 * FR-PAY-3, and the ordering matters: the Payment row is inserted PENDING
 * *before* Monime is called, so a response that never arrives still leaves a
 * record to reconcile against. Creating the row only on success is how a
 * customer ends up debited against an order that has no idea it was paid.
 */
export async function createMobileMoneyPayment(input: {
  orderId: string;
  /** Restricts the code to one handset when we know the number. */
  phoneE164?: string | undefined;
  staffId?: string | undefined;
}): Promise<MobileMoneyPayment> {
  if (!isMonimeConfigured()) {
    throw new UpstreamError('monime', 'Mobile money is not configured on this server.');
  }

  const order = await repos.orders.findByIdDetailed(input.orderId);
  if (!order) throw new NotFoundError('Order not found.');

  if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REFUNDED) {
    throw new ConflictError('That order is closed.');
  }

  const settled = await repos.payments.sumSettledForOrder(order.id);
  const outstanding = sumMinor(order.totalMinor, -settled);
  if (outstanding <= 0) throw new ConflictError('That order is already paid.');

  // A live code for the same order is reused rather than duplicated — two
  // codes for one order is two ways for the customer to pay it twice.
  const existing = order.payments.find(
    (payment) => payment.status === PaymentStatus.PENDING && payment.method === PaymentMethod.MOBILE_MONEY,
  );
  if (existing && existing.amountMinor === outstanding && existing.ussdCode) {
    return { payment: existing, ussdCode: existing.ussdCode, amountMinor: existing.amountMinor };
  }

  // ── the row first ──
  const payment = await repos.payments.create({
    orderId: order.id,
    method: PaymentMethod.MOBILE_MONEY,
    status: PaymentStatus.PENDING,
    amountMinor: outstanding,
    provider: MONIME_PROVIDER,
    recordedByStaffId: input.staffId ?? null,
  });

  try {
    const code = await createPaymentCode({
      name: `popNsip order ${order.reference}`,
      amountMinor: outstanding,
      currency: order.currency,
      customerName: order.customer?.name ?? 'popNsip customer',
      // Echoed back on the webhook, which is how it finds its own row without
      // a lookup table.
      reference: order.id,
      authorizedPhoneNumber: input.phoneE164 ?? order.customer?.phoneE164,
      metadata: { orderId: order.id, reference: order.reference, paymentId: payment.id },
    });

    const updated = await repos.payments.update(payment.id, {
      providerRef: code.id,
      ussdCode: code.ussdCode ?? null,
      rawPayload: code as never,
    });

    return { payment: updated, ussdCode: updated.ussdCode, amountMinor: outstanding };
  } catch (error) {
    // The attempt is recorded as failed rather than deleted: an attempt that
    // Monime may yet honour must remain visible to reconciliation.
    await repos.payments.update(payment.id, {
      status: PaymentStatus.FAILED,
      rawPayload: { error: error instanceof Error ? error.message : String(error) } as never,
    });
    throw error;
  }
}

/**
 * Mark a mobile-money payment settled. Called only by the webhook handler and
 * by reconciliation — never by a route acting on a browser redirect (FR-PAY-4).
 */
export async function settleMobileMoneyPayment(input: {
  paymentId: string;
  amountMinor?: number | undefined;
  providerFeeMinor?: number | null | undefined;
  raw?: unknown;
  tx?: TxClient | undefined;
}): Promise<PaymentModel> {
  const repo = input.tx ? repos.payments.withTx(input.tx) : repos.payments;

  return repo.update(input.paymentId, {
    status: PaymentStatus.SUCCEEDED,
    settledAt: new Date(),
    ...(input.amountMinor === undefined ? {} : { amountMinor: input.amountMinor }),
    ...(input.raw === undefined ? {} : { rawPayload: input.raw as never }),
  });
}

export async function markPaymentFailed(paymentId: string, status: PaymentStatus, raw?: unknown) {
  return repos.payments.update(paymentId, {
    status,
    ...(raw === undefined ? {} : { rawPayload: raw as never }),
  });
}

/** The pending Monime attempt for an order, if there is one. */
export async function findPendingMobileMoneyPayment(orderId: string): Promise<PaymentModel | null> {
  const payments = await repos.payments.findForOrder(orderId);
  return (
    payments.find(
      (payment) => payment.method === PaymentMethod.MOBILE_MONEY && payment.status === PaymentStatus.PENDING,
    ) ?? null
  );
}

/**
 * The mobile-money attempt a settlement event is about, whether or not it has
 * already settled.
 *
 * Monime sends two events for one payment and either can arrive first. Looking
 * only for a PENDING row means the second event finds nothing, reports success
 * it did not cause, and throws away the fee data it was carrying — which is
 * the half of the pair that has it.
 */
export async function findMobileMoneyPayment(
  orderId: string,
  providerRef?: string | undefined,
): Promise<PaymentModel | null> {
  const payments = await repos.payments.findForOrder(orderId);
  const mobileMoney = payments.filter((payment) => payment.method === PaymentMethod.MOBILE_MONEY);

  if (providerRef) {
    const exact = mobileMoney.find((payment) => payment.providerRef === providerRef);
    if (exact) return exact;
  }

  return (
    mobileMoney.find((payment) => payment.status === PaymentStatus.PENDING) ??
    mobileMoney.find((payment) => payment.status === PaymentStatus.SUCCEEDED) ??
    mobileMoney[0] ??
    null
  );
}

/**
 * The payments ledger. A read, deliberately separate from the settlement path
 * above — nothing here may change an order's status, and only ActorType.SYSTEM
 * ever settles one (FR-PAY-4).
 */
export function listPayments(args: {
  branchId: string;
  status?: PaymentStatus;
  method?: PaymentMethod;
  from?: Date;
  to?: Date;
  take?: number;
}) {
  return repos.payments.listForBranch({ ...args, take: args.take ?? 100 });
}

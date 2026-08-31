import { randomBytes } from 'node:crypto';

import { prisma } from '@/db/client';
import { ActorType, OrderStatus, OrderType, PaymentMethod } from '@/generated/prisma/enums';
import { OrderChannel as OrderChannelValue } from '@/generated/prisma/enums';
import type { OrderChannel } from '@/generated/prisma/enums';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { sumMinor } from '@/lib/money';
import { normaliseSierraLeoneMobile } from '@/lib/phone';
import { repositories as repos } from '@/repositories';
import type { TxClient } from '@/repositories/base.repository';
import { priceCart, type CartLine } from '@/services/pricing_service';
import { emit } from '@/services/sse_service';

/**
 * Order creation. One transaction, and the price is always the server's.
 */

export type CreateOrderInput = {
  branchId: string;
  channel: OrderChannel;
  type: OrderType;
  paymentMethod: PaymentMethod;
  lines: CartLine[];
  customer: { name: string; phone: string };
  deliveryAddress?: string | undefined;
  deliveryNotes?: string | undefined;
  tableCode?: string | undefined;
  idempotencyKey?: string | undefined;
  /** Set for POS orders so the history event names who took it. */
  staffId?: string | undefined;
};

/** Short, human, and said aloud across a noisy kitchen. */
function generateReference(): string {
  // Digits only: 'PNS-4821' is easier to read back than a mixed-case token.
  const number = randomBytes(3).readUIntBE(0, 3) % 10000;
  return `PNS-${number.toString().padStart(4, '0')}`;
}

/** ≥128 bits, per FR-SHOP-8. */
const generateTrackingToken = (): string => randomBytes(16).toString('hex');

/**
 * Prepaid orders wait on Monime; cash orders wait on a human. The status an
 * order starts in is decided here and nowhere else.
 */
const initialStatus = (method: PaymentMethod): OrderStatus =>
  method === PaymentMethod.MOBILE_MONEY ? OrderStatus.AWAITING_PAYMENT : OrderStatus.PENDING_CONFIRMATION;

function validateForType(input: CreateOrderInput): void {
  if (input.type === OrderType.DELIVERY && !input.deliveryAddress?.trim()) {
    throw new ValidationError('Delivery needs an address.', [
      { path: 'deliveryAddress', message: 'Where should we bring it?' },
    ]);
  }
  if (input.type === OrderType.DINE_IN && !input.tableCode?.trim()) {
    throw new ValidationError('Dine-in needs a table.', [{ path: 'tableCode', message: 'Which table?' }]);
  }
}

export async function createOrder(input: CreateOrderInput) {
  validateForType(input);

  // Normalised before anything else: the phone is the customer's identity, and
  // '076123456' and '+23276123456' must not become two people.
  const phoneE164 = normaliseSierraLeoneMobile(input.customer.phone);

  // FR-SHOP-10: a retry after a dropped connection returns the original order.
  // Checked here for the common case; the unique constraint below is what
  // actually makes it safe against two simultaneous submissions.
  if (input.idempotencyKey) {
    const existing = await repos.orders.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return { order: existing, replayed: true as const };
  }

  const priced = await priceCart(input.branchId, input.lines);

  let tableId: string | null = null;
  if (input.type === OrderType.DINE_IN && input.tableCode) {
    const table = await prisma.restaurantTable.findFirst({
      where: { branchId: input.branchId, code: input.tableCode.trim(), isActive: true },
    });
    if (!table) {
      throw new ValidationError('That table code is not one of ours.', [
        { path: 'tableCode', message: 'Check the code on the QR sticker.' },
      ]);
    }
    tableId = table.id;
  }

  const totalMinor = priced.subtotalMinor;

  try {
    const order = await prisma.$transaction(async (tx: TxClient) => {
      const customer = await repos.customers.withTx(tx).upsertByPhone(phoneE164, input.customer.name.trim());

      const created = await repos.orders.withTx(tx).create({
        reference: generateReference(),
        branchId: input.branchId,
        customerId: customer.id,
        tableId,
        type: input.type,
        status: initialStatus(input.paymentMethod),
        channel: input.channel,
        deliveryAddress: input.deliveryAddress?.trim() ?? null,
        deliveryNotes: input.deliveryNotes?.trim() ?? null,
        subtotalMinor: priced.subtotalMinor,
        adjustmentsMinor: 0,
        totalMinor,
        trackingToken: generateTrackingToken(),
        idempotencyKey: input.idempotencyKey ?? null,
        items: {
          create: priced.lines.map((line) => ({
            menuItemId: line.menuItemId,
            variantId: line.variantId,
            itemNameSnapshot: line.itemNameSnapshot,
            variantNameSnapshot: line.variantNameSnapshot,
            unitPriceMinor: line.unitPriceMinor,
            quantity: line.quantity,
            lineTotalMinor: line.lineTotalMinor,
            notes: line.notes,
            modifiers: {
              create: line.modifiers.map((modifier) => ({
                modifierId: modifier.modifierId,
                nameSnapshot: modifier.nameSnapshot,
                priceMinor: modifier.priceMinor,
              })),
            },
          })),
        },
      });

      await repos.statusEvents.withTx(tx).create({
        orderId: created.id,
        fromStatus: null,
        toStatus: created.status,
        actorType: input.staffId ? ActorType.STAFF : ActorType.CUSTOMER,
        actorStaffId: input.staffId ?? null,
      });

      return created;
    });

    // After commit: the queue learns about the order only once it exists.
    emit(order.branchId, {
      name: 'order.created',
      data: { orderId: order.id, reference: order.reference, status: order.status, type: order.type },
    });

    return { order, replayed: false as const };
  } catch (error) {
    // Two submissions raced past the lookup above. The constraint decided which
    // one won; return the winner rather than a 500.
    if (isUniqueViolation(error, 'idempotency_key') && input.idempotencyKey) {
      const existing = await repos.orders.findByIdempotencyKey(input.idempotencyKey);
      if (existing) return { order: existing, replayed: true as const };
    }

    // A reference collision is a 1-in-10,000 coincidence, not a client error.
    if (isUniqueViolation(error, 'reference')) {
      throw new ConflictError('Could not allocate an order number. Please try again.');
    }

    throw error;
  }
}

function isUniqueViolation(error: unknown, constraintFragment: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== 'P2002') return false;

  const target = candidate.meta?.target;
  const text = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return text.includes(constraintFragment);
}

/**
 * A walk-in taken at the counter (FR-POS-6). Same pricing_service, same
 * snapshots — the only differences are that the customer is optional and the
 * order is confirmed the moment it is entered, because the person is standing
 * there.
 */
export async function createPosOrder(input: {
  branchId: string;
  staffId: string;
  lines: CartLine[];
  customer?: { name?: string | undefined; phone?: string | undefined } | undefined;
  tableCode?: string | undefined;
  type?: OrderType | undefined;
}) {
  const priced = await priceCart(input.branchId, input.lines);
  const type = input.type ?? OrderType.WALK_IN;

  // A Customer is keyed by phone, so a name with no number cannot be stored
  // against one. Rather than drop it silently, the POS says so and refuses.
  if (input.customer?.name?.trim() && !input.customer.phone?.trim()) {
    throw new ValidationError('A customer name needs a phone number to be saved against.', [
      { path: 'customer.phone', message: 'Add a number, or leave the name blank.' },
    ]);
  }

  let customerId: string | null = null;
  if (input.customer?.phone) {
    const phoneE164 = normaliseSierraLeoneMobile(input.customer.phone);
    const customer = await repos.customers.upsertByPhone(phoneE164, input.customer.name?.trim());
    customerId = customer.id;
  }

  let tableId: string | null = null;
  if (input.tableCode) {
    const table = await prisma.restaurantTable.findFirst({
      where: { branchId: input.branchId, code: input.tableCode.trim(), isActive: true },
    });
    if (!table) {
      throw new ValidationError('That table code is not one of ours.', [
        { path: 'tableCode', message: 'Check the code.' },
      ]);
    }
    tableId = table.id;
  }

  return prisma.$transaction(async (tx: TxClient) => {
    const created = await repos.orders.withTx(tx).create({
      reference: generateReference(),
      branchId: input.branchId,
      customerId,
      tableId,
      type,
      status: OrderStatus.CONFIRMED,
      channel: OrderChannelValue.POS,
      subtotalMinor: priced.subtotalMinor,
      adjustmentsMinor: 0,
      totalMinor: priced.subtotalMinor,
      trackingToken: generateTrackingToken(),
      items: {
        create: priced.lines.map((line) => ({
          menuItemId: line.menuItemId,
          variantId: line.variantId,
          itemNameSnapshot: line.itemNameSnapshot,
          variantNameSnapshot: line.variantNameSnapshot,
          unitPriceMinor: line.unitPriceMinor,
          quantity: line.quantity,
          lineTotalMinor: line.lineTotalMinor,
          notes: line.notes,
          modifiers: {
            create: line.modifiers.map((modifier) => ({
              modifierId: modifier.modifierId,
              nameSnapshot: modifier.nameSnapshot,
              priceMinor: modifier.priceMinor,
            })),
          },
        })),
      },
    });

    await repos.statusEvents.withTx(tx).create({
      orderId: created.id,
      fromStatus: null,
      toStatus: created.status,
      actorType: ActorType.STAFF,
      actorStaffId: input.staffId,
    });

    return created;
  })
    .then((created) => {
      emit(created.branchId, {
        name: 'order.created',
        data: { orderId: created.id, reference: created.reference, status: created.status, type: created.type },
      });
      return created;
    });
}

/**
 * A delivery fee or a discount (FR-POS-4's overflow, PRD §13's Q1 proposal).
 *
 * `adjustmentsMinor` and `totalMinor` are recomputed from the adjustment rows
 * rather than incremented, so a retried request cannot drift the total.
 */
export async function addAdjustment(input: {
  orderId: string;
  label: string;
  amountMinor: number;
  staffId: string;
}) {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor === 0) {
    throw new ValidationError('Enter an amount.', [{ path: 'amountMinor', message: 'Must not be zero.' }]);
  }

  return prisma.$transaction(async (tx: TxClient) => {
    const order = await repos.orders.withTx(tx).findById(input.orderId);
    if (!order) throw new NotFoundError('Order not found.');
    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REFUNDED) {
      throw new ConflictError('That order is closed.');
    }

    await repos.adjustments.withTx(tx).create({
      orderId: input.orderId,
      label: input.label.trim(),
      amountMinor: input.amountMinor,
      createdByStaffId: input.staffId,
    });

    const adjustmentsMinor = await repos.adjustments.withTx(tx).sumForOrder(input.orderId, tx);
    const totalMinor = sumMinor(order.subtotalMinor, adjustmentsMinor);

    if (totalMinor < 0) {
      throw new ValidationError('That discount is larger than the order.', [
        { path: 'amountMinor', message: 'The total cannot go below zero.' },
      ]);
    }

    return repos.orders.withTx(tx).update(input.orderId, { adjustmentsMinor, totalMinor });
  }).then((updated) => {
    emit(updated.branchId, {
      name: 'order.updated',
      data: { orderId: updated.id, reference: updated.reference, totalMinor: updated.totalMinor },
    });
    return updated;
  });
}

/** The public tracking view (FR-SHOP-8). Reached by token, never by id. */
export async function getOrderByTrackingToken(token: string) {
  const order = await repos.orders.findByTrackingToken(token);
  if (!order) throw new NotFoundError('We could not find that order.');

  const settledMinor = await repos.payments.sumSettledForOrder(order.id);
  const events = await repos.statusEvents.findForOrder(order.id);

  return {
    order,
    events,
    settledMinor,
    balanceDueMinor: sumMinor(order.totalMinor, -settledMinor),
  };
}

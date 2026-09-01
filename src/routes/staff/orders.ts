import { Router } from 'express';
import { z } from 'zod';

import { OrderStatus, OrderType, StaffRole } from '@/generated/prisma/enums';
import { NotFoundError } from '@/lib/errors';
import { phoneSearchFragment } from '@/lib/phone';
import { actorOf, handler, requiredParam } from '@/lib/route';
import { requireAuth, requireRole } from '@/middleware/auth';
import { repositories as repos } from '@/repositories';
import { audit } from '@/services/audit_service';
import { addAdjustment, createPosOrder } from '@/services/order_service';
import { allowedTransitions, transition } from '@/services/order_status_service';
import {
  balanceFor,
  createMobileMoneyPayment,
  recordCashPayment,
  recordRefund,
} from '@/services/payment_service';
import { subscribe } from '@/services/sse_service';

/**
 * The POS surface. Everything here is staff-only; the money-moving and
 * destructive actions are manager-and-above.
 */
export const staffOrdersRouter: Router = Router();

const isManager = (role: StaffRole): boolean => role === StaffRole.MANAGER || role === StaffRole.OWNER;

/**
 * The live queue (FR-POS-2). Mounted before the parameterised routes so
 * '/stream' is never read as an order id.
 */
staffOrdersRouter.get('/api/staff/orders/stream', requireAuth, (req, res) => {
  const branchId = actorOf(req).branchId;

  // EventSource resends this after a dropped connection; anything newer is
  // replayed so a reconnect does not silently miss an order.
  const header = req.get('Last-Event-ID');
  const lastSeenId = header && /^\d+$/.test(header) ? Number(header) : undefined;

  const unsubscribe = subscribe(branchId, res, lastSeenId);
  req.on('close', unsubscribe);
});

// ─── the queue and search ─────────────────────────────────────────────────

const listQuery = z.object({
  status: z.enum(OrderStatus).optional(),
  type: z.enum(OrderType).optional(),
  search: z.string().trim().min(1).max(60).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  open: z.enum(['true', 'false']).optional(),
  take: z.coerce.number().int().min(1).max(200).default(100),
});

staffOrdersRouter.get(
  '/api/staff/orders',
  requireAuth,
  handler(async (req, res) => {
    const actor = actorOf(req);
    const query = listQuery.parse(req.query);

    // The default view is the queue: open orders only, newest first.
    if (query.open !== 'false' && !query.status && !query.search && !query.from) {
      res.json({ orders: await repos.orders.findOpenForBranch(actor.branchId) });
      return;
    }

    const orders = await repos.orders.findMany({
      where: {
        branchId: actor.branchId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.from || query.to
          ? {
              placedAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
        // FR-POS-8: reference, phone, or name. The phone arm matches on
        // normalised digits, since staff type '077 900100' and the column
        // holds '+23277900100'.
        ...(query.search
          ? {
              OR: [
                { reference: { contains: query.search, mode: 'insensitive' as const } },
                { customer: { name: { contains: query.search, mode: 'insensitive' as const } } },
                ...(phoneSearchFragment(query.search)
                  ? [{ customer: { phoneE164: { contains: phoneSearchFragment(query.search)! } } }]
                  : []),
              ],
            }
          : {}),
      },
      orderBy: { placedAt: 'desc' },
      take: query.take,
      include: { items: { include: { modifiers: true } }, customer: true, payments: true, table: true },
    });

    res.json({ orders });
  }),
);

staffOrdersRouter.get(
  '/api/staff/orders/:id',
  requireAuth,
  handler(async (req, res) => {
    const id = requiredParam(req.params.id, 'Order');
    const order = await repos.orders.findByIdDetailed(id);
    if (!order) throw new NotFoundError('Order not found.');

    const { settledMinor, balanceDueMinor } = await balanceFor(id);
    res.json({
      order,
      settledMinor,
      balanceDueMinor,
      allowedTransitions: allowedTransitions(order.status, order.type),
    });
  }),
);

// ─── walk-in entry ────────────────────────────────────────────────────────

const posOrderSchema = z.object({
  type: z.enum(OrderType).optional(),
  tableCode: z.string().trim().max(20).optional(),
  customer: z
    .object({ name: z.string().trim().max(80).optional(), phone: z.string().trim().optional() })
    .optional(),
  lines: z
    .array(
      z.object({
        menuItemId: z.string().min(1),
        variantId: z.string().min(1).optional(),
        modifierIds: z.array(z.string().min(1)).max(20).default([]),
        quantity: z.number().int().min(1).max(99),
        notes: z.string().trim().max(280).optional(),
      }),
    )
    .min(1)
    .max(50),
});

staffOrdersRouter.post(
  '/api/staff/orders',
  requireAuth,
  handler(async (req, res) => {
    const actor = actorOf(req);
    const parsed = posOrderSchema.parse(req.body);

    const order = await createPosOrder({ ...parsed, branchId: actor.branchId, staffId: actor.id });

    await audit({
      actor,
      action: 'order.created_at_pos',
      targetType: 'Order',
      targetId: order.id,
      after: { reference: order.reference, totalMinor: order.totalMinor },
      requestId: req.id,
    });
    res.status(201).json({ order });
  }),
);

// ─── status ───────────────────────────────────────────────────────────────

staffOrdersRouter.patch(
  '/api/staff/orders/:id/status',
  requireAuth,
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Order');
    const { status, reason } = z
      .object({ status: z.enum(OrderStatus), reason: z.string().trim().max(280).optional() })
      .parse(req.body);

    // FR-POS-10: a double-tap, or a retry after a timeout, must not be an
    // error. The order is already where the caller wanted it, so say so.
    const current = await repos.orders.findById(id);
    if (!current) throw new NotFoundError('Order not found.');
    if (current.status === status) {
      res.json({ order: current, changed: false });
      return;
    }

    const { order } = await transition({
      orderId: id,
      to: status,
      actor: { type: 'STAFF', staffId: actor.id, isManager: isManager(actor.role) },
      reason,
    });

    await audit({
      actor,
      action: 'order.status_changed',
      targetType: 'Order',
      targetId: id,
      before: { status: current.status },
      after: { status: order.status },
      requestId: req.id,
    });

    res.json({ order, changed: true });
  }),
);

staffOrdersRouter.post(
  '/api/staff/orders/:id/cancel',
  requireRole(StaffRole.MANAGER),
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Order');
    const { reason } = z.object({ reason: z.string().trim().min(1).max(280) }).parse(req.body);

    const { order } = await transition({
      orderId: id,
      to: OrderStatus.CANCELLED,
      actor: { type: 'STAFF', staffId: actor.id, isManager: true },
      reason,
    });

    await audit({
      actor,
      action: 'order.cancelled',
      targetType: 'Order',
      targetId: id,
      after: { reason },
      requestId: req.id,
    });
    res.json({ order });
  }),
);

// ─── money ────────────────────────────────────────────────────────────────

staffOrdersRouter.post(
  '/api/staff/orders/:id/adjustments',
  requireAuth,
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Order');
    const parsed = z
      .object({ label: z.string().trim().min(1).max(60), amountMinor: z.number().int() })
      .parse(req.body);

    const order = await addAdjustment({ ...parsed, orderId: id, staffId: actor.id });

    await audit({
      actor,
      action: 'order.adjusted',
      targetType: 'Order',
      targetId: id,
      after: { label: parsed.label, amountMinor: parsed.amountMinor, totalMinor: order.totalMinor },
      requestId: req.id,
    });
    res.json({ order });
  }),
);

staffOrdersRouter.post(
  '/api/staff/orders/:id/payments',
  requireAuth,
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Order');
    const parsed = z
      .object({ amountMinor: z.number().int().positive(), tenderedMinor: z.number().int().positive().optional() })
      .parse(req.body);

    const result = await recordCashPayment({ ...parsed, orderId: id, staffId: actor.id });

    await audit({
      actor,
      action: 'payment.cash_recorded',
      targetType: 'Order',
      targetId: id,
      after: { amountMinor: parsed.amountMinor, changeMinor: result.changeMinor },
      requestId: req.id,
    });
    res.status(201).json(result);
  }),
);

staffOrdersRouter.post(
  '/api/staff/orders/:id/refund',
  requireRole(StaffRole.MANAGER),
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Order');
    const parsed = z
      .object({ amountMinor: z.number().int().positive(), reason: z.string().trim().min(1).max(280) })
      .parse(req.body);

    // Recorded, not executed (FR-PAY-10): the money moves outside the system.
    await recordRefund({ orderId: id, amountMinor: parsed.amountMinor, staffId: actor.id });
    const { order } = await transition({
      orderId: id,
      to: OrderStatus.REFUNDED,
      actor: { type: 'STAFF', staffId: actor.id, isManager: true },
      reason: parsed.reason,
    });

    await audit({
      actor,
      action: 'payment.refund_recorded',
      targetType: 'Order',
      targetId: id,
      after: { amountMinor: parsed.amountMinor, reason: parsed.reason },
      requestId: req.id,
    });
    res.json({ order });
  }),
);

/**
 * Staff-initiated mobile-money request (FR-PAY-1). The staff member pushes a
 * code to the customer's handset; only a verified webhook or reconciliation
 * can then mark it paid.
 */
staffOrdersRouter.post(
  '/api/staff/orders/:id/payment-request',
  requireAuth,
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Order');
    const { phone } = z.object({ phone: z.string().trim().optional() }).parse(req.body ?? {});

    const result = await createMobileMoneyPayment({
      orderId: id,
      phoneE164: phone,
      staffId: actor.id,
    });

    await audit({
      actor,
      action: 'payment.monime_requested',
      targetType: 'Order',
      targetId: id,
      after: { amountMinor: result.amountMinor },
      requestId: req.id,
    });

    res.status(201).json({ ussdCode: result.ussdCode, amountMinor: result.amountMinor });
  }),
);

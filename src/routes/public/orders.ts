import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { OrderChannel, OrderType, PaymentMethod } from '@/generated/prisma/enums';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { publicApiLimiter } from '@/middleware/rate_limit';
import { rateLimit } from 'express-rate-limit';
import { isTest } from '@/config/env';
import { TooManyRequestsError } from '@/lib/errors';
import { repositories } from '@/repositories';
import { createOrder, getOrderByTrackingToken } from '@/services/order_service';
import { createMobileMoneyPayment, findPendingMobileMoneyPayment } from '@/services/payment_service';
import { getPublicSettings } from '@/services/settings_service';

/** Placing an order is stricter than reading a menu. */
const createOrderLimiter: RequestHandler = isTest
  ? (_req, _res, next) => next()
  : rateLimit({
      windowMs: 10 * 60 * 1000,
      limit: 10,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_req, _res, next) => next(new TooManyRequestsError('Too many orders from this device just now.')),
    });

export const publicOrdersRouter: Router = Router();

const cartLine = z.object({
  menuItemId: z.string().min(1),
  variantId: z.string().min(1).optional(),
  modifierIds: z.array(z.string().min(1)).max(20).default([]),
  quantity: z.number().int().min(1).max(99),
  notes: z.string().trim().max(280).optional(),
});

const createOrderSchema = z.object({
  type: z.enum(OrderType).refine((value) => value !== OrderType.WALK_IN, {
    message: 'Walk-in orders are taken at the counter.',
  }),
  paymentMethod: z.enum(PaymentMethod),
  lines: z.array(cartLine).min(1).max(50),
  customer: z.object({
    name: z.string().trim().min(1).max(80),
    phone: z.string().trim().min(1),
  }),
  deliveryAddress: z.string().trim().max(300).optional(),
  deliveryNotes: z.string().trim().max(300).optional(),
  tableCode: z.string().trim().max(20).optional(),
});

const handler =
  (fn: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

publicOrdersRouter.get(
  '/api/settings/public',
  publicApiLimiter,
  handler(async (_req, res) => {
    const settings = await getPublicSettings();
    // Opening state changes by the minute, so this is cached briefly at most.
    res.set('Cache-Control', 'public, max-age=15');
    res.json(settings);
  }),
);

publicOrdersRouter.post(
  '/api/orders',
  createOrderLimiter,
  handler(async (req, res) => {
    const parsed = createOrderSchema.parse(req.body);

    const branch = await repositories.branches.findFirst();
    if (!branch) throw new NotFoundError('No branch is configured.');

    const enabled = {
      [OrderType.DELIVERY]: branch.deliveryEnabled,
      [OrderType.PICKUP]: branch.pickupEnabled,
      [OrderType.DINE_IN]: branch.dineInEnabled,
      [OrderType.WALK_IN]: false,
    };
    if (!enabled[parsed.type]) {
      throw new ValidationError('That order type is not available right now.', [
        { path: 'type', message: 'Choose another way to receive your order.' },
      ]);
    }

    // FR-SHOP-10. Trusted only as an opaque key — it never influences pricing.
    const header = req.get('Idempotency-Key');
    const idempotencyKey = header && /^[\w-]{8,128}$/.test(header) ? header : undefined;

    const { order, replayed } = await createOrder({
      ...parsed,
      branchId: branch.id,
      channel: OrderChannel.WEB,
      idempotencyKey,
    });

    // A replay is not a new order, so it is a 200 rather than a 201.
    res.status(replayed ? 200 : 201).json({
      order: {
        id: order.id,
        reference: order.reference,
        status: order.status,
        totalMinor: order.totalMinor,
        currency: order.currency,
        trackingToken: order.trackingToken,
      },
      replayed,
    });
  }),
);

publicOrdersRouter.get(
  '/api/orders/track/:token',
  publicApiLimiter,
  handler(async (req, res) => {
    const token = req.params.token;
    if (typeof token !== 'string' || token.length < 16) throw new NotFoundError('We could not find that order.');

    const { order, events, settledMinor, balanceDueMinor } = await getOrderByTrackingToken(token);

    // The token is the credential, so this must never be cached anywhere shared.
    res.set('Cache-Control', 'no-store');
    res.json({
      order: {
        reference: order.reference,
        status: order.status,
        type: order.type,
        placedAt: order.placedAt,
        subtotalMinor: order.subtotalMinor,
        adjustmentsMinor: order.adjustmentsMinor,
        totalMinor: order.totalMinor,
        currency: order.currency,
        deliveryAddress: order.deliveryAddress,
        items: order.items.map((item) => ({
          name: item.itemNameSnapshot,
          variantName: item.variantNameSnapshot,
          quantity: item.quantity,
          lineTotalMinor: item.lineTotalMinor,
          notes: item.notes,
          modifiers: item.modifiers.map((modifier) => ({
            name: modifier.nameSnapshot,
            priceMinor: modifier.priceMinor,
          })),
        })),
      },
      settledMinor,
      balanceDueMinor,
      events: events.map((event) => ({ toStatus: event.toStatus, createdAt: event.createdAt })),
    });
  }),
);

/**
 * Start a mobile-money payment for an order the customer already placed
 * (PRD §10.1). Reached by tracking token, so it needs no session.
 */
publicOrdersRouter.post(
  '/api/orders/track/:token/pay',
  createOrderLimiter,
  handler(async (req, res) => {
    const token = req.params.token;
    if (typeof token !== 'string' || token.length < 16) throw new NotFoundError('We could not find that order.');

    const { order } = await getOrderByTrackingToken(token);
    const { ussdCode, amountMinor } = await createMobileMoneyPayment({
      orderId: order.id,
      phoneE164: order.customer?.phoneE164,
    });

    res.set('Cache-Control', 'no-store');
    res.json({ ussdCode, amountMinor, currency: order.currency });
  }),
);

/**
 * Payment state for the "checking your payment…" screen.
 *
 * FR-PAY-4: this reports what the SERVER knows, which is only ever what a
 * verified webhook or a server-side status check established. A browser
 * arriving back from the provider proves nothing and is never treated as
 * proof.
 */
publicOrdersRouter.get(
  '/api/orders/track/:token/payment',
  publicApiLimiter,
  handler(async (req, res) => {
    const token = req.params.token;
    if (typeof token !== 'string' || token.length < 16) throw new NotFoundError('We could not find that order.');

    const { order, settledMinor, balanceDueMinor } = await getOrderByTrackingToken(token);
    const pending = await findPendingMobileMoneyPayment(order.id);

    res.set('Cache-Control', 'no-store');
    res.json({
      status: order.status,
      settledMinor,
      balanceDueMinor,
      isPaid: balanceDueMinor <= 0,
      pending: pending ? { ussdCode: pending.ussdCode, amountMinor: pending.amountMinor } : null,
    });
  }),
);

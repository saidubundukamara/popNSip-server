import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ActorType, OrderStatus, OrderType } from '@/generated/prisma/enums';
import { ForbiddenError, IllegalTransitionError, ValidationError } from '@/lib/errors';
import {
  TERMINAL_STATUSES,
  TRANSITIONS,
  allowedTransitions,
  assertTransitionAllowed,
  findRule,
} from '@/services/order_status_service';

const staff = { type: ActorType.STAFF, staffId: 's1', isManager: false } as const;
const manager = { type: ActorType.STAFF, staffId: 'm1', isManager: true } as const;
const system = { type: ActorType.SYSTEM } as const;
const customer = { type: ActorType.CUSTOMER } as const;

const allow = (
  from: OrderStatus,
  to: OrderStatus,
  orderType: OrderType,
  actor: Parameters<typeof assertTransitionAllowed>[0]['actor'],
  reason?: string,
) => assertTransitionAllowed({ from, to, orderType, actor, reason });

describe('order state machine', () => {
  it('walks a pickup order from confirmation to completion', () => {
    allow(OrderStatus.PENDING_CONFIRMATION, OrderStatus.CONFIRMED, OrderType.PICKUP, staff);
    allow(OrderStatus.CONFIRMED, OrderStatus.PREPARING, OrderType.PICKUP, staff);
    allow(OrderStatus.PREPARING, OrderStatus.READY, OrderType.PICKUP, staff);
    allow(OrderStatus.READY, OrderStatus.COMPLETED, OrderType.PICKUP, staff);
  });

  it('routes READY by order type', () => {
    allow(OrderStatus.READY, OrderStatus.OUT_FOR_DELIVERY, OrderType.DELIVERY, staff);
    allow(OrderStatus.READY, OrderStatus.SERVED, OrderType.DINE_IN, staff);
    allow(OrderStatus.READY, OrderStatus.COMPLETED, OrderType.PICKUP, staff);
    allow(OrderStatus.READY, OrderStatus.COMPLETED, OrderType.WALK_IN, staff);

    // …and refuses the routes that belong to another type.
    assert.throws(
      () => allow(OrderStatus.READY, OrderStatus.OUT_FOR_DELIVERY, OrderType.PICKUP, staff),
      IllegalTransitionError,
    );
    assert.throws(
      () => allow(OrderStatus.READY, OrderStatus.SERVED, OrderType.DELIVERY, staff),
      IllegalTransitionError,
    );
    assert.throws(
      () => allow(OrderStatus.READY, OrderStatus.COMPLETED, OrderType.DELIVERY, staff),
      IllegalTransitionError,
    );
  });

  it('lets only the system confirm payment', () => {
    allow(OrderStatus.AWAITING_PAYMENT, OrderStatus.CONFIRMED, OrderType.DELIVERY, system);

    // PRD §7.2: "Only the system, never a human, may move an order out of
    // AWAITING_PAYMENT on the basis of payment."
    assert.throws(
      () => allow(OrderStatus.AWAITING_PAYMENT, OrderStatus.CONFIRMED, OrderType.DELIVERY, manager),
      (error: unknown) => {
        assert.ok(error instanceof ForbiddenError);
        assert.match(error.message, /verified payment/);
        return true;
      },
    );
  });

  it('still lets staff cancel an unpaid order', () => {
    allow(OrderStatus.AWAITING_PAYMENT, OrderStatus.CANCELLED, OrderType.DELIVERY, staff);
  });

  it('requires a manager to cancel an accepted order', () => {
    assert.throws(
      () => allow(OrderStatus.PREPARING, OrderStatus.CANCELLED, OrderType.PICKUP, staff, 'burnt'),
      (error: unknown) => {
        assert.ok(error instanceof ForbiddenError);
        assert.match(error.message, /manager/i);
        return true;
      },
    );
    allow(OrderStatus.PREPARING, OrderStatus.CANCELLED, OrderType.PICKUP, manager, 'burnt');
  });

  it('requires a reason where the PRD asks for one', () => {
    assert.throws(
      () => allow(OrderStatus.PREPARING, OrderStatus.CANCELLED, OrderType.PICKUP, manager),
      ValidationError,
    );
    assert.throws(
      () => allow(OrderStatus.PREPARING, OrderStatus.CANCELLED, OrderType.PICKUP, manager, '   '),
      ValidationError,
    );
    allow(OrderStatus.PREPARING, OrderStatus.CANCELLED, OrderType.PICKUP, manager, 'kitchen fire');
  });

  it('refuses to skip a step', () => {
    for (const [from, to] of [
      [OrderStatus.CONFIRMED, OrderStatus.READY],
      [OrderStatus.PENDING_CONFIRMATION, OrderStatus.PREPARING],
      [OrderStatus.CONFIRMED, OrderStatus.COMPLETED],
      [OrderStatus.PREPARING, OrderStatus.COMPLETED],
    ] as const) {
      assert.throws(() => allow(from, to, OrderType.PICKUP, manager, 'why'), IllegalTransitionError, `${from}->${to}`);
    }
  });

  it('refuses to go backwards', () => {
    for (const [from, to] of [
      [OrderStatus.READY, OrderStatus.PREPARING],
      [OrderStatus.PREPARING, OrderStatus.CONFIRMED],
      [OrderStatus.COMPLETED, OrderStatus.READY],
    ] as const) {
      assert.throws(() => allow(from, to, OrderType.PICKUP, manager, 'why'), IllegalTransitionError, `${from}->${to}`);
    }
  });

  it('treats a no-op as illegal rather than silently succeeding', () => {
    assert.throws(
      () => allow(OrderStatus.PREPARING, OrderStatus.PREPARING, OrderType.PICKUP, staff),
      (error: unknown) => {
        assert.ok(error instanceof IllegalTransitionError);
        assert.match(error.message, /already in that state/);
        return true;
      },
    );
  });

  it('allows only the refund path out of a terminal status', () => {
    for (const from of TERMINAL_STATUSES) {
      const outward = allowedTransitions(from, OrderType.PICKUP);
      assert.deepEqual(
        outward,
        from === OrderStatus.REFUNDED ? [] : [OrderStatus.REFUNDED],
        `${from} should only refund`,
      );
    }

    allow(OrderStatus.COMPLETED, OrderStatus.REFUNDED, OrderType.PICKUP, manager, 'spoiled');
    allow(OrderStatus.CANCELLED, OrderStatus.REFUNDED, OrderType.PICKUP, manager, 'paid then cancelled');
    assert.throws(
      () => allow(OrderStatus.REFUNDED, OrderStatus.COMPLETED, OrderType.PICKUP, manager, 'no'),
      IllegalTransitionError,
    );
  });

  it('never lets a customer drive a status change', () => {
    for (const from of Object.keys(TRANSITIONS) as OrderStatus[]) {
      for (const rule of TRANSITIONS[from]) {
        assert.ok(
          !rule.actors.includes(ActorType.CUSTOMER),
          `${from} -> ${rule.to} must not be customer-driven`,
        );
        assert.throws(
          () => allow(from, rule.to, OrderType.DELIVERY, customer, 'because'),
          `${from} -> ${rule.to} accepted a customer actor`,
        );
      }
    }
  });

  it('exposes the POS one-tap actions for a status', () => {
    assert.deepEqual(allowedTransitions(OrderStatus.CONFIRMED, OrderType.DELIVERY), [
      OrderStatus.PREPARING,
      OrderStatus.CANCELLED,
    ]);
    assert.deepEqual(allowedTransitions(OrderStatus.READY, OrderType.DINE_IN), [
      OrderStatus.SERVED,
      OrderStatus.CANCELLED,
    ]);
  });

  it('has a rule table matching the PRD, with no status left unreachable', () => {
    const reachable = new Set<OrderStatus>([
      OrderStatus.DRAFT,
      OrderStatus.AWAITING_PAYMENT,
      OrderStatus.PENDING_CONFIRMATION,
    ]);
    for (const rules of Object.values(TRANSITIONS)) {
      for (const rule of rules) reachable.add(rule.to);
    }

    for (const status of Object.values(OrderStatus)) {
      assert.ok(reachable.has(status), `${status} is unreachable`);
      assert.ok(TRANSITIONS[status] !== undefined, `${status} has no rule list`);
    }
  });

  it('findRule respects order type', () => {
    assert.ok(findRule(OrderStatus.READY, OrderStatus.SERVED, OrderType.DINE_IN));
    assert.equal(findRule(OrderStatus.READY, OrderStatus.SERVED, OrderType.PICKUP), null);
  });
});

import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

import { prisma } from '@/db/client';
import { ActorType, OrderChannel, OrderStatus, OrderType } from '@/generated/prisma/enums';
import { repositories as repos } from '@/repositories';

/**
 * Phase 1 acceptance check: push an order all the way through the repository
 * layer and read it back. Proves the schema, the transaction rebinding in
 * BaseRepository.withTx, the snapshot columns, and the idempotency constraint
 * all behave. Run against a seeded development database:
 *
 *   npm run verify:db
 *
 * It cleans up after itself, so the seed data is left as it was.
 */

const reference = `PNS-${randomBytes(2).toString('hex').toUpperCase()}`;
const trackingToken = randomBytes(16).toString('hex');
const idempotencyKey = randomUUID();
const phoneE164 = '+23276000001';

async function main(): Promise<void> {
  const branch = await repos.branches.findFirst();
  assert.ok(branch, 'no branch — run `npx prisma db seed` first');

  // ── read the menu the way pricing_service will ────────────────────────────
  const jollof = await prisma.menuItem.findFirst({
    where: { name: 'Jollof Rice' },
    include: { variants: true, modifierGroups: { include: { modifiers: true } } },
  });
  assert.ok(jollof, 'seed data missing Jollof Rice');

  const large = jollof.variants.find((v) => v.name === 'Large');
  const chicken = jollof.modifierGroups.flatMap((g) => g.modifiers).find((m) => m.name === 'Grilled chicken');
  assert.ok(large && chicken, 'seed data missing the expected variant/modifier');

  const quantity = 2;
  const unitPriceMinor = large.priceMinor;
  const lineTotalMinor = (unitPriceMinor + chicken.priceMinor) * quantity;

  const customer = await repos.customers.upsertByPhone(phoneE164, 'Round Trip');

  // ── write: one transaction, several repositories ──────────────────────────
  const created = await prisma.$transaction(async (tx) => {
    const order = await repos.orders.withTx(tx).create({
      reference,
      branchId: branch.id,
      customerId: customer.id,
      type: OrderType.PICKUP,
      status: OrderStatus.PENDING_CONFIRMATION,
      channel: OrderChannel.WEB,
      subtotalMinor: lineTotalMinor,
      totalMinor: lineTotalMinor,
      trackingToken,
      idempotencyKey,
      items: {
        create: [
          {
            menuItemId: jollof.id,
            variantId: large.id,
            itemNameSnapshot: jollof.name,
            variantNameSnapshot: large.name,
            unitPriceMinor,
            quantity,
            lineTotalMinor,
            modifiers: {
              create: [{ modifierId: chicken.id, nameSnapshot: chicken.name, priceMinor: chicken.priceMinor }],
            },
          },
        ],
      },
    });

    await repos.statusEvents.withTx(tx).create({
      orderId: order.id,
      toStatus: OrderStatus.PENDING_CONFIRMATION,
      actorType: ActorType.CUSTOMER,
    });

    return order;
  });

  // ── read back ─────────────────────────────────────────────────────────────
  const fetched = await repos.orders.findByTrackingToken(trackingToken);
  assert.ok(fetched, 'order not found by tracking token');
  assert.equal(fetched.id, created.id);
  assert.equal(fetched.totalMinor, lineTotalMinor);
  assert.equal(fetched.items.length, 1);
  assert.equal(fetched.items[0]?.itemNameSnapshot, 'Jollof Rice');
  assert.equal(fetched.items[0]?.variantNameSnapshot, 'Large');
  assert.equal(fetched.items[0]?.modifiers[0]?.nameSnapshot, 'Grilled chicken');

  assert.ok(await repos.orders.findByReference(reference), 'order not found by reference');
  assert.ok(await repos.orders.findByIdempotencyKey(idempotencyKey), 'order not found by idempotency key');

  const open = await repos.orders.findOpenForBranch(branch.id);
  assert.ok(open.some((o) => o.id === created.id), 'order missing from the open queue');

  const history = await repos.statusEvents.findForOrder(created.id);
  assert.equal(history.length, 1);

  // ── the idempotency constraint actually holds ─────────────────────────────
  // Prisma logs the rejected insert on its `error` channel. That log line is
  // the assertion below succeeding, not a failure.
  console.warn('Expecting a unique-constraint error next — that is the test.');
  await assert.rejects(
    () =>
      repos.orders.create({
        reference: `${reference}-dup`,
        branchId: branch.id,
        type: OrderType.PICKUP,
        status: OrderStatus.PENDING_CONFIRMATION,
        channel: OrderChannel.WEB,
        subtotalMinor: 0,
        totalMinor: 0,
        trackingToken: randomBytes(16).toString('hex'),
        idempotencyKey,
      }),
    /Unique constraint|P2002/,
    'a duplicate idempotency key was accepted',
  );

  // ── replayed webhooks claim once ──────────────────────────────────────────
  const eventId = `evt_${randomUUID()}`;
  const claim = { provider: 'monime', providerEventId: eventId, eventName: 'payment_code.completed', payload: {} };
  assert.ok(await repos.webhookEvents.claim(claim), 'first claim should succeed');
  assert.equal(await repos.webhookEvents.claim(claim), null, 'replayed event should not claim twice');

  // ── clean up ──────────────────────────────────────────────────────────────
  await prisma.order.delete({ where: { id: created.id } });
  await prisma.webhookEvent.deleteMany({ where: { providerEventId: eventId } });
  await prisma.customer.delete({ where: { id: customer.id } });

  console.warn(`Round trip OK — ${reference} written, read back, and cleaned up.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

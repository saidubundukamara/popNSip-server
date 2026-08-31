import argon2 from 'argon2';

import { env } from '@/config/env';
import { prisma } from '@/db/client';
import { StaffRole } from '@/generated/prisma/enums';

/**
 * Development seed: one branch, three staff accounts across the role
 * hierarchy, six tables, and a menu with enough shape — variants, required
 * and optional modifier groups, an unavailable item — that later phases have
 * realistic data to work against.
 *
 * Re-runnable: it clears the tables it owns first. It refuses to run against
 * production.
 */

/** Prices are written in leones and stored as minor units. */
const Le = (leones: number): number => Math.round(leones * 100);

const DEV_PASSWORD = 'popnsip-dev';

async function reset(): Promise<void> {
  // Children first: every FK above is Restrict or Cascade, so order matters.
  await prisma.orderItemModifier.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.orderAdjustment.deleteMany();
  await prisma.orderStatusEvent.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.whatsAppMessage.deleteMany();
  await prisma.order.deleteMany();
  await prisma.whatsAppConversation.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.modifier.deleteMany();
  await prisma.modifierGroup.deleteMany();
  await prisma.itemVariant.deleteMany();
  await prisma.menuItem.deleteMany();
  await prisma.category.deleteMany();
  await prisma.restaurantTable.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.staffUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.webhookEvent.deleteMany();
}

async function main(): Promise<void> {
  if (env.NODE_ENV === 'production') {
    throw new Error('The seed deletes data. It will not run against production.');
  }

  await reset();

  const branch = await prisma.branch.create({
    data: {
      name: 'popNsip Freetown',
      address: '12 Wilkinson Road, Freetown',
      phoneE164: '+23278077127',
      timezone: env.RESTAURANT_TIMEZONE,
      openingHours: {
        mon: [{ open: '10:00', close: '22:00' }],
        tue: [{ open: '10:00', close: '22:00' }],
        wed: [{ open: '10:00', close: '22:00' }],
        thu: [{ open: '10:00', close: '22:00' }],
        fri: [{ open: '10:00', close: '23:00' }],
        sat: [{ open: '11:00', close: '23:00' }],
        sun: [{ open: '12:00', close: '21:00' }],
      },
    },
  });

  const passwordHash = await argon2.hash(DEV_PASSWORD);
  await prisma.staffUser.createMany({
    data: [
      { branchId: branch.id, email: 'owner@popnsip.test', name: 'Aminata Kamara', role: StaffRole.OWNER, passwordHash },
      { branchId: branch.id, email: 'manager@popnsip.test', name: 'Ibrahim Sesay', role: StaffRole.MANAGER, passwordHash },
      { branchId: branch.id, email: 'staff@popnsip.test', name: 'Fatmata Bangura', role: StaffRole.STAFF, passwordHash },
    ],
  });

  await prisma.restaurantTable.createMany({
    data: Array.from({ length: 6 }, (_, i) => ({
      branchId: branch.id,
      code: `T${i + 1}`,
      label: `Table ${i + 1}`,
    })),
  });

  // ── Rice dishes ───────────────────────────────────────────────────────────
  const rice = await prisma.category.create({
    data: { branchId: branch.id, name: 'Rice Dishes', sortOrder: 0 },
  });

  const protein = (sortOrder: number) => ({
    name: 'Choose your protein',
    minSelect: 1,
    maxSelect: 1,
    sortOrder,
    modifiers: {
      create: [
        { name: 'Grilled chicken', priceMinor: Le(25), sortOrder: 0 },
        { name: 'Beef', priceMinor: Le(30), sortOrder: 1 },
        { name: 'Fish', priceMinor: Le(35), sortOrder: 2 },
        { name: 'No protein', priceMinor: 0, sortOrder: 3 },
      ],
    },
  });

  const extras = (sortOrder: number) => ({
    name: 'Extras',
    minSelect: 0,
    maxSelect: 3,
    sortOrder,
    modifiers: {
      create: [
        { name: 'Fried plantain', priceMinor: Le(15), sortOrder: 0 },
        { name: 'Boiled egg', priceMinor: Le(10), sortOrder: 1 },
        { name: 'Garden salad', priceMinor: Le(15), sortOrder: 2 },
        { name: 'Extra pepper sauce', priceMinor: Le(5), sortOrder: 3 },
      ],
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: rice.id,
      name: 'Jollof Rice',
      description: 'Smoky party jollof cooked in pepper and tomato stew.',
      basePriceMinor: Le(50),
      sortOrder: 0,
      variants: {
        create: [
          { name: 'Regular', priceMinor: Le(50), sortOrder: 0 },
          { name: 'Large', priceMinor: Le(75), sortOrder: 1 },
        ],
      },
      modifierGroups: { create: [protein(0), extras(1)] },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: rice.id,
      name: 'Cassava Leaf (Plassas)',
      description: 'Slow-cooked cassava leaf in palm oil, served with white rice.',
      basePriceMinor: Le(55),
      sortOrder: 1,
      variants: {
        create: [
          { name: 'Regular', priceMinor: Le(55), sortOrder: 0 },
          { name: 'Large', priceMinor: Le(80), sortOrder: 1 },
        ],
      },
      modifierGroups: { create: [protein(0), extras(1)] },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: rice.id,
      name: 'Groundnut Stew',
      description: 'Peanut stew with rice.',
      basePriceMinor: Le(55),
      sortOrder: 2,
      modifierGroups: { create: [protein(0)] },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: rice.id,
      name: 'Fried Rice',
      description: 'Wok-fried rice with mixed vegetables.',
      basePriceMinor: Le(60),
      sortOrder: 3,
      modifierGroups: { create: [protein(0), extras(1)] },
    },
  });

  // ── Grills ────────────────────────────────────────────────────────────────
  const grills = await prisma.category.create({
    data: { branchId: branch.id, name: 'Grills', sortOrder: 1 },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: grills.id,
      name: 'Grilled Chicken',
      description: 'Charcoal-grilled, marinated overnight.',
      basePriceMinor: Le(40),
      sortOrder: 0,
      variants: {
        create: [
          { name: 'Quarter', priceMinor: Le(40), sortOrder: 0 },
          { name: 'Half', priceMinor: Le(70), sortOrder: 1 },
          { name: 'Whole', priceMinor: Le(130), sortOrder: 2 },
        ],
      },
      modifierGroups: {
        create: [
          {
            name: 'Sauce',
            minSelect: 1,
            maxSelect: 2,
            sortOrder: 0,
            modifiers: {
              create: [
                { name: 'Pepper sauce', priceMinor: 0, sortOrder: 0 },
                { name: 'Garlic sauce', priceMinor: Le(5), sortOrder: 1 },
                { name: 'Barbecue', priceMinor: Le(5), sortOrder: 2 },
              ],
            },
          },
        ],
      },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: grills.id,
      name: 'Grilled Fish',
      description: 'Whole fish, grilled with onion and pepper.',
      basePriceMinor: Le(90),
      sortOrder: 1,
      variants: {
        create: [
          { name: 'Snapper', priceMinor: Le(90), sortOrder: 0 },
          { name: 'Barracuda', priceMinor: Le(110), sortOrder: 1 },
        ],
      },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: grills.id,
      name: 'Beef Suya',
      description: 'Spiced skewers with sliced onion.',
      basePriceMinor: Le(45),
      sortOrder: 2,
      // Deliberately out of stock, so availability handling has a real case.
      isAvailable: false,
    },
  });

  // ── Sides ─────────────────────────────────────────────────────────────────
  const sides = await prisma.category.create({
    data: { branchId: branch.id, name: 'Sides', sortOrder: 2 },
  });

  await prisma.menuItem.createMany({
    data: [
      { categoryId: sides.id, name: 'Fried Plantain', basePriceMinor: Le(20), sortOrder: 0 },
      { categoryId: sides.id, name: 'French Fries', basePriceMinor: Le(25), sortOrder: 1 },
      { categoryId: sides.id, name: 'Garden Salad', basePriceMinor: Le(25), sortOrder: 2 },
      { categoryId: sides.id, name: 'Extra Rice', basePriceMinor: Le(15), sortOrder: 3 },
    ],
  });

  // ── Drinks ────────────────────────────────────────────────────────────────
  const drinks = await prisma.category.create({
    data: { branchId: branch.id, name: 'Drinks', sortOrder: 3 },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: drinks.id,
      name: 'Soft Drink',
      basePriceMinor: Le(12),
      sortOrder: 0,
      variants: {
        create: [
          { name: 'Coca-Cola', priceMinor: Le(12), sortOrder: 0 },
          { name: 'Fanta', priceMinor: Le(12), sortOrder: 1 },
          { name: 'Sprite', priceMinor: Le(12), sortOrder: 2 },
        ],
      },
    },
  });

  await prisma.menuItem.createMany({
    data: [
      { categoryId: drinks.id, name: 'Ginger Beer', basePriceMinor: Le(18), sortOrder: 1 },
      { categoryId: drinks.id, name: 'Sobo (Hibiscus)', basePriceMinor: Le(15), sortOrder: 2 },
      { categoryId: drinks.id, name: 'Bottled Water', basePriceMinor: Le(8), sortOrder: 3 },
    ],
  });

  const [categories, items, variants, modifiers, tables, staff] = await Promise.all([
    prisma.category.count(),
    prisma.menuItem.count(),
    prisma.itemVariant.count(),
    prisma.modifier.count(),
    prisma.restaurantTable.count(),
    prisma.staffUser.count(),
  ]);

  console.warn(
    `Seeded ${branch.name}: ${categories} categories, ${items} items, ${variants} variants, ` +
      `${modifiers} modifiers, ${tables} tables, ${staff} staff.\n` +
      `Sign in as owner@popnsip.test / ${DEV_PASSWORD}`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

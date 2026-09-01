import argon2 from "argon2";

import { env } from "@/config/env";
import { prisma } from "@/db/client";
import { StaffRole } from "@/generated/prisma/enums";

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

const DEV_PASSWORD = "popnsip-dev";

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

/**
 * Photographs for the seeded menu, from Unsplash.
 *
 * Not decoration. The POS grid is built on recognising a dish by sight rather
 * than reading its name — that is most of what makes it usable by someone who
 * is not a confident reader — and with every item photo-less it degrades to a
 * wall of identical tiles. Seeding without pictures means never seeing the
 * screen the way it is meant to work.
 *
 * Free to use under the Unsplash licence. Every URL here was requested and
 * confirmed to return an image before it was written down; none was guessed.
 *
 * `imagePublicId` stays null on purpose: it exists so a Cloudinary upload can
 * later be deleted, and these are not Cloudinary's to delete. The web app's
 * `imageUrl()` only rewrites Cloudinary URLs, so these pass through untouched
 * and the width baked in below is the width served.
 */
const UNSPLASH: Record<string, string> = {
  "Jollof Rice": "photo-1665332195309-9d75071138f0",
  "Cassava Leaf (Plassas)": "photo-1763048443535-1243379234e2",
  "Groundnut Stew": "photo-1667506997090-5e5ffc128711",
  "Fried Rice": "photo-1603133872878-684f208fb84b",
  "Grilled Chicken": "photo-1712579733874-c3a79f0f9d12",
  "Grilled Fish": "photo-1600699899970-b1c9fadd8f9e",
  "Beef Suya": "photo-1765584830134-12d879ad13bd",
  "Fried Plantain": "photo-1540714605746-4f474eefc6d4",
  "French Fries": "photo-1630384060421-cb20d0e0649d",
  "Garden Salad": "photo-1771759441598-0105381b2e70",
  "Extra Rice": "photo-1705147271933-5c7052f15a90",
  "Soft Drink": "photo-1594971475674-6a97f8fe8c2b",
  "Ginger Beer": "photo-1610450622827-195cb7308af8",
  "Sobo (Hibiscus)": "photo-1563636680-28d36aeb83a4",
  "Bottled Water": "photo-1523362628745-0c100150b504",
};

const photo = (name: string): string | null =>
  UNSPLASH[name]
    ? `https://images.unsplash.com/${UNSPLASH[name]}?auto=format&fit=crop&w=800&q=70`
    : null;

async function main(): Promise<void> {
  if (env.NODE_ENV === "production") {
    throw new Error(
      "The seed deletes data. It will not run against production.",
    );
  }

  await reset();

  const branch = await prisma.branch.create({
    data: {
      name: "popNsip Freetown",
      address: "12 Wilkinson Road, Freetown",
      phoneE164: "+23278077127",
      timezone: env.RESTAURANT_TIMEZONE,
      openingHours: {
        mon: [{ open: "10:00", close: "22:00" }],
        tue: [{ open: "10:00", close: "22:00" }],
        wed: [{ open: "10:00", close: "22:00" }],
        thu: [{ open: "10:00", close: "22:00" }],
        fri: [{ open: "10:00", close: "23:00" }],
        sat: [{ open: "11:00", close: "23:00" }],
        sun: [{ open: "12:00", close: "21:00" }],
      },
    },
  });

  const passwordHash = await argon2.hash(DEV_PASSWORD);
  await prisma.staffUser.createMany({
    data: [
      {
        branchId: branch.id,
        email: "owner@popnsip.test",
        name: "Aminata Kamara",
        role: StaffRole.OWNER,
        passwordHash,
      },
      {
        branchId: branch.id,
        email: "manager@popnsip.test",
        name: "Ibrahim Sesay",
        role: StaffRole.MANAGER,
        passwordHash,
      },
      {
        branchId: branch.id,
        email: "staff@popnsip.test",
        name: "Fatmata Bangura",
        role: StaffRole.STAFF,
        passwordHash,
      },
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
    data: { branchId: branch.id, name: "Rice Dishes", sortOrder: 0 },
  });

  const protein = (sortOrder: number) => ({
    name: "Choose your protein",
    minSelect: 1,
    maxSelect: 1,
    sortOrder,
    modifiers: {
      create: [
        { name: "Grilled chicken", priceMinor: Le(25), sortOrder: 0 },
        { name: "Beef", priceMinor: Le(30), sortOrder: 1 },
        { name: "Fish", priceMinor: Le(35), sortOrder: 2 },
        { name: "No protein", priceMinor: 0, sortOrder: 3 },
      ],
    },
  });

  const extras = (sortOrder: number) => ({
    name: "Extras",
    minSelect: 0,
    maxSelect: 3,
    sortOrder,
    modifiers: {
      create: [
        { name: "Fried plantain", priceMinor: Le(15), sortOrder: 0 },
        { name: "Boiled egg", priceMinor: Le(10), sortOrder: 1 },
        { name: "Garden salad", priceMinor: Le(15), sortOrder: 2 },
        { name: "Extra pepper sauce", priceMinor: Le(5), sortOrder: 3 },
      ],
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: rice.id,
      name: "Jollof Rice",
      description: "Smoky party jollof cooked in pepper and tomato stew.",
      basePriceMinor: Le(50),
      sortOrder: 0,
      imageUrl: photo("Jollof Rice"),
      variants: {
        create: [
          { name: "Regular", priceMinor: Le(50), sortOrder: 0 },
          { name: "Large", priceMinor: Le(75), sortOrder: 1 },
        ],
      },
      modifierGroups: { create: [protein(0), extras(1)] },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: rice.id,
      name: "Cassava Leaf (Plassas)",
      description:
        "Slow-cooked cassava leaf in palm oil, served with white rice.",
      basePriceMinor: Le(55),
      sortOrder: 1,
      imageUrl: photo("Cassava Leaf (Plassas)"),
      variants: {
        create: [
          { name: "Regular", priceMinor: Le(55), sortOrder: 0 },
          { name: "Large", priceMinor: Le(80), sortOrder: 1 },
        ],
      },
      modifierGroups: { create: [protein(0), extras(1)] },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: rice.id,
      name: "Groundnut Stew",
      description: "Peanut stew with rice.",
      basePriceMinor: Le(55),
      sortOrder: 2,
      imageUrl: photo("Groundnut Stew"),
      modifierGroups: { create: [protein(0)] },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: rice.id,
      name: "Fried Rice",
      description: "Wok-fried rice with mixed vegetables.",
      basePriceMinor: Le(60),
      sortOrder: 3,
      imageUrl: photo("Fried Rice"),
      modifierGroups: { create: [protein(0), extras(1)] },
    },
  });

  // ── Grills ────────────────────────────────────────────────────────────────
  const grills = await prisma.category.create({
    data: { branchId: branch.id, name: "Grills", sortOrder: 1 },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: grills.id,
      name: "Grilled Chicken",
      description: "Charcoal-grilled, marinated overnight.",
      basePriceMinor: Le(40),
      sortOrder: 0,
      imageUrl: photo("Grilled Chicken"),
      variants: {
        create: [
          { name: "Quarter", priceMinor: Le(40), sortOrder: 0 },
          { name: "Half", priceMinor: Le(70), sortOrder: 1 },
          { name: "Whole", priceMinor: Le(130), sortOrder: 2 },
        ],
      },
      modifierGroups: {
        create: [
          {
            name: "Sauce",
            minSelect: 1,
            maxSelect: 2,
            sortOrder: 0,
            modifiers: {
              create: [
                { name: "Pepper sauce", priceMinor: 0, sortOrder: 0 },
                { name: "Garlic sauce", priceMinor: Le(5), sortOrder: 1 },
                { name: "Barbecue", priceMinor: Le(5), sortOrder: 2 },
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
      name: "Grilled Fish",
      description: "Whole fish, grilled with onion and pepper.",
      basePriceMinor: Le(90),
      sortOrder: 1,
      imageUrl: photo("Grilled Fish"),
      variants: {
        create: [
          { name: "Snapper", priceMinor: Le(90), sortOrder: 0 },
          { name: "Barracuda", priceMinor: Le(110), sortOrder: 1 },
        ],
      },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: grills.id,
      name: "Beef Suya",
      description: "Spiced skewers with sliced onion.",
      basePriceMinor: Le(45),
      sortOrder: 2,
      imageUrl: photo("Beef Suya"),
      // Deliberately out of stock, so availability handling has a real case.
      isAvailable: false,
    },
  });

  // ── Sides ─────────────────────────────────────────────────────────────────
  const sides = await prisma.category.create({
    data: { branchId: branch.id, name: "Sides", sortOrder: 2 },
  });

  await prisma.menuItem.createMany({
    data: [
      {
        categoryId: sides.id,
        name: "Fried Plantain",
        basePriceMinor: Le(20),
        sortOrder: 0,
        imageUrl: photo("Fried Plantain"),
      },
      {
        categoryId: sides.id,
        name: "French Fries",
        basePriceMinor: Le(25),
        sortOrder: 1,
        imageUrl: photo("French Fries"),
      },
      {
        categoryId: sides.id,
        name: "Garden Salad",
        basePriceMinor: Le(25),
        sortOrder: 2,
        imageUrl: photo("Garden Salad"),
      },
      {
        categoryId: sides.id,
        name: "Extra Rice",
        basePriceMinor: Le(15),
        sortOrder: 3,
        imageUrl: photo("Extra Rice"),
      },
    ],
  });

  // ── Drinks ────────────────────────────────────────────────────────────────
  const drinks = await prisma.category.create({
    data: { branchId: branch.id, name: "Drinks", sortOrder: 3 },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: drinks.id,
      name: "Soft Drink",
      basePriceMinor: Le(12),
      sortOrder: 0,
      imageUrl: photo("Soft Drink"),
      variants: {
        create: [
          { name: "Coca-Cola", priceMinor: Le(12), sortOrder: 0 },
          { name: "Fanta", priceMinor: Le(12), sortOrder: 1 },
          { name: "Sprite", priceMinor: Le(12), sortOrder: 2 },
        ],
      },
    },
  });

  await prisma.menuItem.createMany({
    data: [
      {
        categoryId: drinks.id,
        name: "Ginger Beer",
        basePriceMinor: Le(18),
        sortOrder: 1,
        imageUrl: photo("Ginger Beer"),
      },
      {
        categoryId: drinks.id,
        name: "Sobo (Hibiscus)",
        basePriceMinor: Le(15),
        sortOrder: 2,
        imageUrl: photo("Sobo (Hibiscus)"),
      },
      {
        categoryId: drinks.id,
        name: "Bottled Water",
        basePriceMinor: Le(8),
        sortOrder: 3,
        imageUrl: photo("Bottled Water"),
      },
    ],
  });

  const [categories, items, variants, modifiers, tables, staff] =
    await Promise.all([
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

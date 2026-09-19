import argon2 from "argon2";

import { env } from "@/config/env";
import { prisma } from "@/db/client";
import { StaffRole } from "@/generated/prisma/enums";

/**
 * Development seed: one branch, three staff accounts across the role
 * hierarchy, six tables, and popNsip's dessert-and-drinks menu (waffles, ice
 * cream, coffee and matcha, shakes and slush) with enough shape — variants,
 * required and optional modifier groups, an unavailable item — that every
 * flow has realistic data to work against.
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
  "Classic Waffle": "photo-1562376552-0d160a2f238d",
  "Strawberry Waffle": "photo-1653838049933-872d585b8d81",
  "Chocolate Waffle": "photo-1721078917681-40f74d16d7b7",
  "Waffle à la Mode": "photo-1562513872-634b8fae6dbe",
  "Chicken & Waffle": "photo-1576894712323-995d7ff493b4",
  "Ice Cream Cone": "photo-1497034825429-c343d7c6a68f",
  "Ice Cream Cup": "photo-1562790879-dfde82829db0",
  "Sundae": "photo-1597249536924-b226b1a1259d",
  "Waffle Bowl Sundae": "photo-1724805053611-54c999f9c70c",
  "Mocha": "photo-1529892485617-25f63cd7b1e9",
  "Iced Mocha": "photo-1578314675249-a6910f80cc4e",
  "Matcha Latte": "photo-1515823064-d6e0c04616a7",
  "Iced Matcha": "photo-1749280447307-31a68eb38673",
  "Milkshake": "photo-1553787499-6f9133860278",
  "Oreo Shake": "photo-1572490122747-3968b75cc699",
  "Slush": "photo-1762631178352-f7ae732b42c4",
  "Strawberry Smoothie": "photo-1579954115545-a95591f28bfc",
  "Fresh Lemonade": "photo-1623084921164-4a8c5c37a912",
  "Bubble Tea": "photo-1558857563-b371033873b8",
  "Soft Drink": "photo-1594971475674-6a97f8fe8c2b",
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

  // ── Waffles ───────────────────────────────────────────────────────────────
  const waffles = await prisma.category.create({
    data: { branchId: branch.id, name: "Waffles", sortOrder: 0 },
  });

  const toppings = (sortOrder: number) => ({
    name: "Toppings",
    minSelect: 0,
    maxSelect: 3,
    sortOrder,
    modifiers: {
      create: [
        { name: "Nutella", priceMinor: Le(15), sortOrder: 0 },
        { name: "Fresh strawberries", priceMinor: Le(15), sortOrder: 1 },
        { name: "Banana", priceMinor: Le(10), sortOrder: 2 },
        { name: "Whipped cream", priceMinor: Le(10), sortOrder: 3 },
        { name: "Scoop of vanilla ice cream", priceMinor: Le(20), sortOrder: 4 },
      ],
    },
  });

  const syrup = (sortOrder: number) => ({
    name: "Syrup",
    minSelect: 1,
    maxSelect: 1,
    sortOrder,
    modifiers: {
      create: [
        { name: "Maple syrup", priceMinor: 0, sortOrder: 0 },
        { name: "Chocolate sauce", priceMinor: 0, sortOrder: 1 },
        { name: "Caramel sauce", priceMinor: 0, sortOrder: 2 },
        { name: "Honey", priceMinor: 0, sortOrder: 3 },
      ],
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: waffles.id,
      name: "Classic Waffle",
      description: "Golden Belgian waffle, crisp outside and fluffy inside.",
      basePriceMinor: Le(60),
      sortOrder: 0,
      imageUrl: photo("Classic Waffle"),
      variants: {
        create: [
          { name: "Single", priceMinor: Le(60), sortOrder: 0 },
          { name: "Double stack", priceMinor: Le(100), sortOrder: 1 },
        ],
      },
      modifierGroups: { create: [syrup(0), toppings(1)] },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: waffles.id,
      name: "Strawberry Waffle",
      description: "Fresh strawberries, whipped cream and a dusting of sugar.",
      basePriceMinor: Le(85),
      sortOrder: 1,
      imageUrl: photo("Strawberry Waffle"),
      modifierGroups: { create: [toppings(0)] },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: waffles.id,
      name: "Chocolate Waffle",
      description: "Drenched in Nutella and chocolate sauce.",
      basePriceMinor: Le(85),
      sortOrder: 2,
      imageUrl: photo("Chocolate Waffle"),
      modifierGroups: { create: [toppings(0)] },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: waffles.id,
      name: "Waffle à la Mode",
      description: "Warm waffle with a scoop of vanilla ice cream.",
      basePriceMinor: Le(90),
      sortOrder: 3,
      imageUrl: photo("Waffle à la Mode"),
      modifierGroups: { create: [syrup(0)] },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: waffles.id,
      name: "Chicken & Waffle",
      description: "Crispy fried chicken on a waffle with hot honey.",
      basePriceMinor: Le(120),
      sortOrder: 4,
      imageUrl: photo("Chicken & Waffle"),
      // Deliberately out of stock, so availability handling has a real case.
      isAvailable: false,
    },
  });

  // ── Ice cream ─────────────────────────────────────────────────────────────
  const iceCream = await prisma.category.create({
    data: { branchId: branch.id, name: "Ice Cream", sortOrder: 1 },
  });

  const flavours = (sortOrder: number, maxSelect: number) => ({
    name: "Flavours",
    minSelect: 1,
    maxSelect,
    sortOrder,
    modifiers: {
      create: [
        { name: "Vanilla", priceMinor: 0, sortOrder: 0 },
        { name: "Chocolate", priceMinor: 0, sortOrder: 1 },
        { name: "Strawberry", priceMinor: 0, sortOrder: 2 },
        { name: "Cookies & cream", priceMinor: 0, sortOrder: 3 },
        { name: "Mango", priceMinor: 0, sortOrder: 4 },
      ],
    },
  });

  const sprinkles = (sortOrder: number) => ({
    name: "Extras",
    minSelect: 0,
    maxSelect: 3,
    sortOrder,
    modifiers: {
      create: [
        { name: "Sprinkles", priceMinor: Le(5), sortOrder: 0 },
        { name: "Chocolate sauce", priceMinor: Le(5), sortOrder: 1 },
        { name: "Oreo crumbs", priceMinor: Le(10), sortOrder: 2 },
      ],
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: iceCream.id,
      name: "Ice Cream Cone",
      description: "Soft scoops in a crunchy waffle cone.",
      basePriceMinor: Le(35),
      sortOrder: 0,
      imageUrl: photo("Ice Cream Cone"),
      variants: {
        create: [
          { name: "One scoop", priceMinor: Le(35), sortOrder: 0 },
          { name: "Two scoops", priceMinor: Le(55), sortOrder: 1 },
        ],
      },
      modifierGroups: { create: [flavours(0, 2), sprinkles(1)] },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: iceCream.id,
      name: "Ice Cream Cup",
      description: "Scoops in a cup, for the walk home.",
      basePriceMinor: Le(35),
      sortOrder: 1,
      imageUrl: photo("Ice Cream Cup"),
      variants: {
        create: [
          { name: "One scoop", priceMinor: Le(35), sortOrder: 0 },
          { name: "Two scoops", priceMinor: Le(55), sortOrder: 1 },
          { name: "Three scoops", priceMinor: Le(75), sortOrder: 2 },
        ],
      },
      modifierGroups: { create: [flavours(0, 3), sprinkles(1)] },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: iceCream.id,
      name: "Sundae",
      description: "Vanilla scoops, berry sauce and a cherry on top.",
      basePriceMinor: Le(70),
      sortOrder: 2,
      imageUrl: photo("Sundae"),
      modifierGroups: { create: [sprinkles(0)] },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: iceCream.id,
      name: "Waffle Bowl Sundae",
      description: "Three scoops in a waffle bowl with wafers and sauce.",
      basePriceMinor: Le(95),
      sortOrder: 3,
      imageUrl: photo("Waffle Bowl Sundae"),
      modifierGroups: { create: [flavours(0, 3), sprinkles(1)] },
    },
  });

  // ── Coffee & matcha ───────────────────────────────────────────────────────
  const coffee = await prisma.category.create({
    data: { branchId: branch.id, name: "Coffee & Matcha", sortOrder: 2 },
  });

  const cupSizes = (regular: number, large: number) => ({
    create: [
      { name: "Regular", priceMinor: Le(regular), sortOrder: 0 },
      { name: "Large", priceMinor: Le(large), sortOrder: 1 },
    ],
  });

  const milk = (sortOrder: number) => ({
    name: "Milk",
    minSelect: 1,
    maxSelect: 1,
    sortOrder,
    modifiers: {
      create: [
        { name: "Whole milk", priceMinor: 0, sortOrder: 0 },
        { name: "Oat milk", priceMinor: Le(10), sortOrder: 1 },
        { name: "Almond milk", priceMinor: Le(10), sortOrder: 2 },
      ],
    },
  });

  const coffeeExtras = (sortOrder: number) => ({
    name: "Extras",
    minSelect: 0,
    maxSelect: 3,
    sortOrder,
    modifiers: {
      create: [
        { name: "Extra shot", priceMinor: Le(10), sortOrder: 0 },
        { name: "Whipped cream", priceMinor: Le(8), sortOrder: 1 },
        { name: "Vanilla syrup", priceMinor: Le(8), sortOrder: 2 },
        { name: "Caramel syrup", priceMinor: Le(8), sortOrder: 3 },
      ],
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: coffee.id,
      name: "Mocha",
      description: "Espresso, chocolate and steamed milk.",
      basePriceMinor: Le(55),
      sortOrder: 0,
      imageUrl: photo("Mocha"),
      variants: cupSizes(55, 70),
      modifierGroups: { create: [milk(0), coffeeExtras(1)] },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: coffee.id,
      name: "Iced Mocha",
      description: "Mocha over ice, topped with cream.",
      basePriceMinor: Le(60),
      sortOrder: 1,
      imageUrl: photo("Iced Mocha"),
      variants: cupSizes(60, 75),
      modifierGroups: { create: [milk(0), coffeeExtras(1)] },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: coffee.id,
      name: "Matcha Latte",
      description: "Ceremonial-grade matcha whisked into steamed milk.",
      basePriceMinor: Le(60),
      sortOrder: 2,
      imageUrl: photo("Matcha Latte"),
      variants: cupSizes(60, 75),
      modifierGroups: { create: [milk(0)] },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: coffee.id,
      name: "Iced Matcha",
      description: "Layered matcha and cold milk over ice.",
      basePriceMinor: Le(65),
      sortOrder: 3,
      imageUrl: photo("Iced Matcha"),
      variants: cupSizes(65, 80),
      modifierGroups: { create: [milk(0)] },
    },
  });

  // ── Shakes & slush ────────────────────────────────────────────────────────
  const shakes = await prisma.category.create({
    data: { branchId: branch.id, name: "Shakes & Slush", sortOrder: 3 },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: shakes.id,
      name: "Milkshake",
      description: "Thick, cold and blended to order.",
      basePriceMinor: Le(55),
      sortOrder: 0,
      imageUrl: photo("Milkshake"),
      variants: {
        create: [
          { name: "Vanilla", priceMinor: Le(55), sortOrder: 0 },
          { name: "Chocolate", priceMinor: Le(55), sortOrder: 1 },
          { name: "Strawberry", priceMinor: Le(55), sortOrder: 2 },
        ],
      },
      modifierGroups: {
        create: [
          {
            name: "Extras",
            minSelect: 0,
            maxSelect: 2,
            sortOrder: 0,
            modifiers: {
              create: [
                { name: "Whipped cream", priceMinor: Le(8), sortOrder: 0 },
                { name: "Extra scoop", priceMinor: Le(15), sortOrder: 1 },
              ],
            },
          },
        ],
      },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: shakes.id,
      name: "Oreo Shake",
      description: "Cookies-and-cream shake with chocolate drizzle.",
      basePriceMinor: Le(65),
      sortOrder: 1,
      imageUrl: photo("Oreo Shake"),
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: shakes.id,
      name: "Slush",
      description: "Ice-cold and brightly coloured. Pick your flavour.",
      basePriceMinor: Le(30),
      sortOrder: 2,
      imageUrl: photo("Slush"),
      variants: {
        create: [
          { name: "Blue raspberry", priceMinor: Le(30), sortOrder: 0 },
          { name: "Strawberry", priceMinor: Le(30), sortOrder: 1 },
          { name: "Green apple", priceMinor: Le(30), sortOrder: 2 },
          { name: "Mango", priceMinor: Le(30), sortOrder: 3 },
        ],
      },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: shakes.id,
      name: "Strawberry Smoothie",
      description: "Strawberry, banana and yoghurt.",
      basePriceMinor: Le(50),
      sortOrder: 3,
      imageUrl: photo("Strawberry Smoothie"),
    },
  });

  // ── Drinks ────────────────────────────────────────────────────────────────
  const drinks = await prisma.category.create({
    data: { branchId: branch.id, name: "Drinks", sortOrder: 4 },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: drinks.id,
      name: "Bubble Tea",
      description: "Milk tea with chewy tapioca pearls.",
      basePriceMinor: Le(55),
      sortOrder: 0,
      imageUrl: photo("Bubble Tea"),
      variants: {
        create: [
          { name: "Classic milk tea", priceMinor: Le(55), sortOrder: 0 },
          { name: "Brown sugar", priceMinor: Le(60), sortOrder: 1 },
          { name: "Taro", priceMinor: Le(60), sortOrder: 2 },
        ],
      },
    },
  });

  await prisma.menuItem.create({
    data: {
      categoryId: drinks.id,
      name: "Soft Drink",
      basePriceMinor: Le(12),
      sortOrder: 2,
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
        name: "Fresh Lemonade",
        description: "Squeezed to order, lightly sweetened.",
        basePriceMinor: Le(25),
        sortOrder: 1,
        imageUrl: photo("Fresh Lemonade"),
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

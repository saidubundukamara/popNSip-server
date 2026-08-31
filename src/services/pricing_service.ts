import { InvalidModifierSelectionError, ItemUnavailableError, ValidationError } from '@/lib/errors';
import { multiplyMinor, sumMinor } from '@/lib/money';
import { repositories as repos } from '@/repositories';

/**
 * The single source of truth for what an order costs.
 *
 * Nothing else in the codebase may compute an order total. The storefront, the
 * POS and the WhatsApp bot all call `priceCart`, which is how FR-SHOP-7 stays
 * true in three places instead of drifting in two of them.
 *
 * Every row is loaded fresh from the database. Client-supplied prices are not
 * merely distrusted — they are never read. The same applies to the WhatsApp
 * catalog: a cart's total from Whapi is display data, never the charge.
 */

export type CartLine = {
  menuItemId: string;
  variantId?: string | undefined;
  modifierIds: string[];
  quantity: number;
  notes?: string | undefined;
};

export type PricedModifier = {
  modifierId: string;
  nameSnapshot: string;
  priceMinor: number;
};

export type PricedLine = {
  menuItemId: string;
  variantId: string | null;
  itemNameSnapshot: string;
  variantNameSnapshot: string | null;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
  notes: string | null;
  modifiers: PricedModifier[];
};

export type PricedOrder = {
  lines: PricedLine[];
  subtotalMinor: number;
};

export const MAX_QUANTITY_PER_LINE = 99;

export async function priceCart(branchId: string, lines: CartLine[]): Promise<PricedOrder> {
  if (lines.length === 0) {
    throw new ValidationError('The cart is empty.', [{ path: 'lines', message: 'Add at least one item.' }]);
  }

  for (const [index, line] of lines.entries()) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_QUANTITY_PER_LINE) {
      throw new ValidationError('Invalid quantity.', [
        { path: `lines.${index}.quantity`, message: `Choose between 1 and ${MAX_QUANTITY_PER_LINE}.` },
      ]);
    }
  }

  // One query for every item in the cart, not one per line.
  const items = await repos.menuItems.findForPricing(lines.map((line) => line.menuItemId));
  const byId = new Map(items.map((item) => [item.id, item]));

  const unavailable: { menuItemId: string; name: string; reason: string }[] = [];
  const problems: { groupId: string; groupName: string; message: string }[] = [];
  const priced: PricedLine[] = [];

  for (const line of lines) {
    const item = byId.get(line.menuItemId);

    // Archived or deleted items are indistinguishable to a stale cart, and the
    // customer needs a name either way.
    if (!item) {
      unavailable.push({ menuItemId: line.menuItemId, name: 'An item', reason: 'is no longer on the menu' });
      continue;
    }
    if (item.archivedAt || !item.isAvailable) {
      unavailable.push({ menuItemId: item.id, name: item.name, reason: 'is not available right now' });
      continue;
    }

    // ── variant ──
    const liveVariants = item.variants.filter((variant) => !variant.archivedAt && variant.isAvailable);
    let variantNameSnapshot: string | null = null;
    let unitPriceMinor = item.basePriceMinor;
    let variantId: string | null = null;

    if (liveVariants.length > 0) {
      if (!line.variantId) {
        problems.push({
          groupId: `${item.id}:variant`,
          groupName: item.name,
          message: 'Choose an option before ordering this item.',
        });
        continue;
      }

      const variant = liveVariants.find((candidate) => candidate.id === line.variantId);
      if (!variant) {
        unavailable.push({ menuItemId: item.id, name: item.name, reason: 'has an option that is no longer available' });
        continue;
      }

      variantId = variant.id;
      variantNameSnapshot = variant.name;
      unitPriceMinor = variant.priceMinor;
    } else if (line.variantId) {
      // The cart names a variant the item no longer has.
      unavailable.push({ menuItemId: item.id, name: item.name, reason: 'has changed its options' });
      continue;
    }

    // ── modifiers ──
    const chosen = new Set(line.modifierIds);
    const pricedModifiers: PricedModifier[] = [];
    let lineHasProblem = false;

    for (const group of item.modifierGroups) {
      const live = group.modifiers.filter((modifier) => !modifier.archivedAt && modifier.isAvailable);
      const selected = live.filter((modifier) => chosen.has(modifier.id));

      // A chosen modifier that is no longer live is a stale cart, not a
      // selection error — say so with the group's name.
      const selectedButGone = group.modifiers.filter(
        (modifier) => chosen.has(modifier.id) && (modifier.archivedAt !== null || !modifier.isAvailable),
      );
      if (selectedButGone.length > 0) {
        unavailable.push({
          menuItemId: item.id,
          name: `${item.name} (${selectedButGone.map((modifier) => modifier.name).join(', ')})`,
          reason: 'is not available right now',
        });
        lineHasProblem = true;
        break;
      }

      if (selected.length < group.minSelect) {
        problems.push({
          groupId: group.id,
          groupName: group.name,
          message: `Choose at least ${group.minSelect}.`,
        });
        lineHasProblem = true;
        continue;
      }
      if (selected.length > group.maxSelect) {
        problems.push({
          groupId: group.id,
          groupName: group.name,
          message: `Choose no more than ${group.maxSelect}.`,
        });
        lineHasProblem = true;
        continue;
      }

      for (const modifier of selected) {
        pricedModifiers.push({
          modifierId: modifier.id,
          nameSnapshot: modifier.name,
          priceMinor: modifier.priceMinor,
        });
        chosen.delete(modifier.id);
      }
    }

    if (lineHasProblem) continue;

    // Anything left over belongs to no group on this item.
    if (chosen.size > 0) {
      problems.push({
        groupId: `${item.id}:unknown`,
        groupName: item.name,
        message: 'A chosen extra does not belong to this item.',
      });
      continue;
    }

    const perUnitMinor = sumMinor(unitPriceMinor, ...pricedModifiers.map((modifier) => modifier.priceMinor));

    priced.push({
      menuItemId: item.id,
      variantId,
      itemNameSnapshot: item.name,
      variantNameSnapshot,
      unitPriceMinor,
      quantity: line.quantity,
      lineTotalMinor: multiplyMinor(perUnitMinor, line.quantity),
      notes: line.notes?.trim() || null,
      modifiers: pricedModifiers,
    });
  }

  // Availability first: an unavailable item is the more urgent thing to fix,
  // and re-choosing a modifier for an item that is off the menu is wasted work.
  if (unavailable.length > 0) throw new ItemUnavailableError(unavailable);
  if (problems.length > 0) throw new InvalidModifierSelectionError(problems);

  return { lines: priced, subtotalMinor: sumMinor(...priced.map((line) => line.lineTotalMinor)) };
}

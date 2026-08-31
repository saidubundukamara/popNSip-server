import type { CartLine } from '@/services/pricing_service';

/**
 * The cart as it lives in the bot session, and the rules for deciding what is
 * still missing from it.
 *
 * A WhatsApp catalog cart carries only a product id and a quantity. An item
 * with variants, or with a modifier group that requires a choice, therefore
 * arrives incomplete — `pricing_service` will refuse it, and rightly. The bot
 * has to ask. This module works out exactly what it has to ask about, and is
 * pure so that logic can be tested without a conversation around it.
 */

export type PendingLine = {
  menuItemId: string;
  quantity: number;
  variantId?: string | undefined;
  modifierIds: string[];
  notes?: string | undefined;
};

/** What the menu says an item needs before it can be priced. */
export type ItemRequirements = {
  menuItemId: string;
  name: string;
  variants: { id: string; name: string; priceMinor: number }[];
  groups: {
    id: string;
    name: string;
    minSelect: number;
    maxSelect: number;
    modifiers: { id: string; name: string; priceMinor: number }[];
  }[];
};

export type Question =
  | { kind: 'variant'; lineIndex: number; item: ItemRequirements }
  | { kind: 'group'; lineIndex: number; item: ItemRequirements; group: ItemRequirements['groups'][number] };

/**
 * The next thing the bot needs to ask, or null when the cart can be priced.
 *
 * Lines are walked in order and each line's variant is settled before its
 * groups, so the customer answers one item at a time rather than being asked
 * about three dishes at once.
 */
export function nextQuestion(lines: PendingLine[], requirements: Map<string, ItemRequirements>): Question | null {
  for (const [lineIndex, line] of lines.entries()) {
    const item = requirements.get(line.menuItemId);
    if (!item) continue;

    if (item.variants.length > 0 && !line.variantId) {
      return { kind: 'variant', lineIndex, item };
    }

    for (const group of item.groups) {
      if (group.minSelect < 1) continue;

      const chosen = line.modifierIds.filter((id) =>
        group.modifiers.some((modifier) => modifier.id === id),
      );
      if (chosen.length < group.minSelect) {
        return { kind: 'group', lineIndex, item, group };
      }
    }
  }

  return null;
}

/**
 * Record an answer.
 *
 * Returns a new array rather than mutating: the session accumulator stores
 * what it is given, and a mutated array shared with the previous state is how
 * a rollback stops rolling anything back.
 */
export function applyAnswer(
  lines: PendingLine[],
  question: Question,
  selectionId: string,
): PendingLine[] {
  return lines.map((line, index) => {
    if (index !== question.lineIndex) return line;

    if (question.kind === 'variant') {
      return { ...line, variantId: selectionId };
    }

    // Single-select groups replace rather than accumulate, so tapping twice
    // corrects the answer instead of breaking the maximum.
    const others = line.modifierIds.filter(
      (id) => !question.group.modifiers.some((modifier) => modifier.id === id),
    );
    const existing = line.modifierIds.filter((id) =>
      question.group.modifiers.some((modifier) => modifier.id === id),
    );

    const chosen =
      question.group.maxSelect === 1
        ? [selectionId]
        : [...new Set([...existing, selectionId])].slice(0, question.group.maxSelect);

    return { ...line, modifierIds: [...others, ...chosen] };
  });
}

/** Session shape → what pricing_service takes. */
export const toCartLines = (lines: PendingLine[]): CartLine[] =>
  lines.map((line) => ({
    menuItemId: line.menuItemId,
    ...(line.variantId ? { variantId: line.variantId } : {}),
    modifierIds: line.modifierIds,
    quantity: line.quantity,
    ...(line.notes ? { notes: line.notes } : {}),
  }));

/** Merge a catalog cart into whatever the customer already had. */
export function mergeLines(existing: PendingLine[], incoming: PendingLine[]): PendingLine[] {
  const merged = [...existing];

  for (const line of incoming) {
    // Only stack lines that are configured identically; two Jollof Rice with
    // different proteins are two lines, not one of quantity two.
    const match = merged.find(
      (candidate) =>
        candidate.menuItemId === line.menuItemId &&
        candidate.variantId === line.variantId &&
        candidate.modifierIds.length === line.modifierIds.length &&
        candidate.modifierIds.every((id) => line.modifierIds.includes(id)),
    );

    if (match) match.quantity = Math.min(99, match.quantity + line.quantity);
    else merged.push({ ...line });
  }

  return merged;
}

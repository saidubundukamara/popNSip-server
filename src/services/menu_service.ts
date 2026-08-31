import { prisma } from '@/db/client';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { repositories as repos } from '@/repositories';
import { queueItemSync } from '@/services/catalog_sync_service';
import { deleteMenuImage } from '@/services/media_service';

/**
 * Menu rules live here, not in routes.
 *
 * Two of them shape everything else:
 *   * Archiving is the delete (FR-MENU-7). Anything an order references keeps
 *     existing so historical orders still render their original names and
 *     prices; `deleteX` is available only while nothing points at the row.
 *   * The public menu is one query. Nested includes, filtered at every level,
 *     rather than a walk over categories issuing a query per item.
 */

const now = () => new Date();

// ─── reads ────────────────────────────────────────────────────────────────

export const getPublicMenu = (branchId: string) => repos.menuItems.findPublicMenu(branchId);

export const getManagedMenu = (branchId: string) => repos.menuItems.findManagedMenu(branchId);

export async function getPublicItem(id: string) {
  const item = await repos.menuItems.findDetailed(id);
  if (!item || item.archivedAt || !item.isAvailable) throw new NotFoundError('Item not found.');
  return item;
}

export async function getItem(id: string) {
  const item = await repos.menuItems.findDetailed(id);
  if (!item) throw new NotFoundError('Item not found.');
  return item;
}

// ─── categories ───────────────────────────────────────────────────────────

export type CategoryInput = { name: string; description?: string | null; isActive?: boolean };

export async function createCategory(branchId: string, input: CategoryInput) {
  const count = await repos.categories.count({ branchId, archivedAt: null });
  return repos.categories.create({ ...input, branchId, sortOrder: count });
}

export async function updateCategory(id: string, input: Partial<CategoryInput>) {
  const before = await repos.categories.findById(id);
  if (!before) throw new NotFoundError('Category not found.');
  return { before, after: await repos.categories.update(id, input) };
}

export async function archiveCategory(id: string) {
  const before = await repos.categories.findById(id);
  if (!before) throw new NotFoundError('Category not found.');
  if (before.archivedAt) return { before, after: before };
  return { before, after: await repos.categories.update(id, { archivedAt: now(), isActive: false }) };
}

export async function deleteCategory(id: string) {
  const category = await repos.categories.findById(id);
  if (!category) throw new NotFoundError('Category not found.');

  if ((await repos.categories.countOrderReferences(id)) > 0) {
    throw new ConflictError('This category has items on past orders. Archive it instead.');
  }
  if ((await repos.categories.countItems(id)) > 0) {
    throw new ConflictError('Move or archive the items in this category first.');
  }

  await prisma.category.delete({ where: { id } });
  return category;
}

/** Reordering is one transaction: a half-applied order is worse than none. */
export async function reorderCategories(branchId: string, ids: string[]) {
  const owned = await repos.categories.findForBranch(branchId);
  const ownedIds = new Set(owned.map((category) => category.id));
  const unknown = ids.filter((id) => !ownedIds.has(id));

  if (unknown.length > 0) {
    throw new ValidationError('Reorder list contains categories that are not on this menu.', [
      { path: 'ids', message: unknown.join(', ') },
    ]);
  }

  await prisma.$transaction(async (tx) => {
    await repos.categories.reorder(ids, tx);
  });
}

// ─── items ────────────────────────────────────────────────────────────────

export type MenuItemInput = {
  categoryId: string;
  name: string;
  description?: string | null;
  basePriceMinor: number;
  isAvailable?: boolean;
};

export async function createItem(input: MenuItemInput) {
  const category = await repos.categories.findById(input.categoryId);
  if (!category || category.archivedAt) throw new NotFoundError('Category not found.');

  const count = await repos.menuItems.count({ categoryId: input.categoryId, archivedAt: null });
  const created = await repos.menuItems.create({ ...input, sortOrder: count });

  // Queued, never awaited: a menu edit must not wait on Whapi's latency.
  queueItemSync(created.id);
  return created;
}

export async function updateItem(id: string, input: Partial<MenuItemInput>) {
  const before = await repos.menuItems.findById(id);
  if (!before) throw new NotFoundError('Item not found.');

  if (input.categoryId && input.categoryId !== before.categoryId) {
    const category = await repos.categories.findById(input.categoryId);
    if (!category || category.archivedAt) throw new NotFoundError('Category not found.');
  }

  const after = await repos.menuItems.update(id, input);
  queueItemSync(id);
  return { before, after };
}

/** FR-MENU-5. Separated from updateItem because it is the one-tap action. */
export async function setItemAvailability(id: string, isAvailable: boolean) {
  const before = await repos.menuItems.findById(id);
  if (!before) throw new NotFoundError('Item not found.');

  const after = await repos.menuItems.update(id, { isAvailable });
  // The catalog learns about a sold-out item as 'out of stock', not a
  // deletion, so the product id survives for when it comes back.
  queueItemSync(id);
  return { before, after };
}

export async function archiveItem(id: string) {
  const before = await repos.menuItems.findById(id);
  if (!before) throw new NotFoundError('Item not found.');
  if (before.archivedAt) return { before, after: before };

  const after = await repos.menuItems.update(id, { archivedAt: now(), isAvailable: false });
  queueItemSync(id);
  return { before, after };
}

export async function deleteItem(id: string) {
  const item = await repos.menuItems.findById(id);
  if (!item) throw new NotFoundError('Item not found.');

  if ((await repos.menuItems.countOrderReferences(id)) > 0) {
    throw new ConflictError('This item appears on past orders. Archive it instead.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.modifier.deleteMany({ where: { group: { menuItemId: id } } });
    await tx.modifierGroup.deleteMany({ where: { menuItemId: id } });
    await tx.itemVariant.deleteMany({ where: { menuItemId: id } });
    await tx.menuItem.delete({ where: { id } });
  });

  // The row is gone either way; an orphaned asset is the lesser problem.
  if (item.imagePublicId) await deleteMenuImage(item.imagePublicId).catch(() => undefined);

  return item;
}

export async function reorderItems(categoryId: string, ids: string[]) {
  const items = await repos.menuItems.findMany({ where: { categoryId, archivedAt: null } });
  const ownedIds = new Set(items.map((item) => item.id));
  const unknown = ids.filter((id) => !ownedIds.has(id));

  if (unknown.length > 0) {
    throw new ValidationError('Reorder list contains items that are not in this category.', [
      { path: 'ids', message: unknown.join(', ') },
    ]);
  }

  await prisma.$transaction(async (tx) => {
    await Promise.all(ids.map((id, index) => tx.menuItem.update({ where: { id }, data: { sortOrder: index } })));
  });
}

export async function setItemImage(id: string, image: { url: string; publicId: string }) {
  const before = await repos.menuItems.findById(id);
  if (!before) throw new NotFoundError('Item not found.');

  const after = await repos.menuItems.update(id, { imageUrl: image.url, imagePublicId: image.publicId });
  queueItemSync(id);

  // Replace, then remove the old asset — never the reverse, or a failed
  // upload leaves the item with no image at all.
  if (before.imagePublicId && before.imagePublicId !== image.publicId) {
    await deleteMenuImage(before.imagePublicId).catch(() => undefined);
  }

  return after;
}

// ─── variants ─────────────────────────────────────────────────────────────

export type VariantInput = { name: string; priceMinor: number; isAvailable?: boolean };

export async function createVariant(menuItemId: string, input: VariantInput) {
  const item = await repos.menuItems.findById(menuItemId);
  if (!item) throw new NotFoundError('Item not found.');

  const count = await repos.itemVariants.count({ menuItemId, archivedAt: null });
  return repos.itemVariants.create({ ...input, menuItemId, sortOrder: count });
}

export async function updateVariant(id: string, input: Partial<VariantInput>) {
  const before = await repos.itemVariants.findById(id);
  if (!before) throw new NotFoundError('Variant not found.');
  return { before, after: await repos.itemVariants.update(id, input) };
}

export async function archiveVariant(id: string) {
  const before = await repos.itemVariants.findById(id);
  if (!before) throw new NotFoundError('Variant not found.');

  if ((await repos.itemVariants.countOrderReferences(id)) === 0) {
    await prisma.itemVariant.delete({ where: { id } });
    return { before, after: null };
  }

  return { before, after: await repos.itemVariants.update(id, { archivedAt: now(), isAvailable: false }) };
}

// ─── modifier groups and modifiers ────────────────────────────────────────

export type ModifierGroupInput = { name: string; minSelect: number; maxSelect: number };

function assertSelectionBounds(input: { minSelect: number; maxSelect: number }): void {
  if (input.maxSelect < 1) {
    throw new ValidationError('A group must allow at least one selection.', [
      { path: 'maxSelect', message: 'Must be 1 or more.' },
    ]);
  }
  if (input.minSelect > input.maxSelect) {
    throw new ValidationError('Minimum selections cannot exceed the maximum.', [
      { path: 'minSelect', message: `Must be ${input.maxSelect} or fewer.` },
    ]);
  }
}

export async function createModifierGroup(menuItemId: string, input: ModifierGroupInput) {
  const item = await repos.menuItems.findById(menuItemId);
  if (!item) throw new NotFoundError('Item not found.');
  assertSelectionBounds(input);

  const count = await repos.modifierGroups.count({ menuItemId });
  return repos.modifierGroups.create({ ...input, menuItemId, sortOrder: count });
}

export async function updateModifierGroup(id: string, input: Partial<ModifierGroupInput>) {
  const before = await repos.modifierGroups.findById(id);
  if (!before) throw new NotFoundError('Modifier group not found.');

  assertSelectionBounds({
    minSelect: input.minSelect ?? before.minSelect,
    maxSelect: input.maxSelect ?? before.maxSelect,
  });

  return { before, after: await repos.modifierGroups.update(id, input) };
}

export async function deleteModifierGroup(id: string) {
  const group = await repos.modifierGroups.findById(id);
  if (!group) throw new NotFoundError('Modifier group not found.');

  if ((await repos.modifierGroups.countOrderReferences(id)) > 0) {
    throw new ConflictError('Modifiers in this group appear on past orders. Archive them instead.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.modifier.deleteMany({ where: { modifierGroupId: id } });
    await tx.modifierGroup.delete({ where: { id } });
  });

  return group;
}

export type ModifierInput = { name: string; priceMinor: number; isAvailable?: boolean };

export async function createModifier(modifierGroupId: string, input: ModifierInput) {
  const group = await repos.modifierGroups.findById(modifierGroupId);
  if (!group) throw new NotFoundError('Modifier group not found.');

  const count = await repos.modifiers.count({ modifierGroupId, archivedAt: null });
  return repos.modifiers.create({ ...input, modifierGroupId, sortOrder: count });
}

export async function updateModifier(id: string, input: Partial<ModifierInput>) {
  const before = await repos.modifiers.findById(id);
  if (!before) throw new NotFoundError('Modifier not found.');
  return { before, after: await repos.modifiers.update(id, input) };
}

export async function archiveModifier(id: string) {
  const before = await repos.modifiers.findById(id);
  if (!before) throw new NotFoundError('Modifier not found.');

  if ((await repos.modifiers.countOrderReferences(id)) === 0) {
    await prisma.modifier.delete({ where: { id } });
    return { before, after: null };
  }

  return { before, after: await repos.modifiers.update(id, { archivedAt: now(), isAvailable: false }) };
}

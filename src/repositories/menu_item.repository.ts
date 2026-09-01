import type { PrismaClient } from '@/generated/prisma/client';
import type { MenuItemModel } from '@/generated/prisma/models';
import { BaseRepository, type DbClient, type TxClient } from '@/repositories/base.repository';

export class MenuItemRepository extends BaseRepository<PrismaClient['menuItem'], MenuItemModel> {
  protected delegate(db: DbClient) {
    return db.menuItem;
  }

  withTx(tx: TxClient): this {
    return new MenuItemRepository(tx) as this;
  }

  /**
   * The public menu, in one query: active, unarchived, available, in sort
   * order, with the variants and modifier groups the storefront needs to
   * render an item sheet.
   *
   * Unavailable rows are filtered out at every level, not greyed out —
   * FR-MENU-5 says a sold-out item disappears from the storefront. Order
   * validation blocks it a second time, for carts that went stale.
   */
  findPublicMenu(branchId: string) {
    return this.db.category.findMany({
      where: { branchId, isActive: true, archivedAt: null },
      orderBy: { sortOrder: 'asc' },
      include: {
        items: {
          where: { archivedAt: null, isAvailable: true },
          orderBy: { sortOrder: 'asc' },
          include: {
            variants: {
              where: { archivedAt: null, isAvailable: true },
              orderBy: { sortOrder: 'asc' },
            },
            modifierGroups: {
              orderBy: { sortOrder: 'asc' },
              include: {
                modifiers: {
                  where: { archivedAt: null, isAvailable: true },
                  orderBy: { sortOrder: 'asc' },
                },
              },
            },
          },
        },
      },
    });
  }

  /** The manager's view: everything, including archived and unavailable rows. */
  findManagedMenu(branchId: string) {
    return this.db.category.findMany({
      where: { branchId, archivedAt: null },
      orderBy: { sortOrder: 'asc' },
      include: {
        items: {
          where: { archivedAt: null },
          orderBy: { sortOrder: 'asc' },
          include: {
            variants: { where: { archivedAt: null }, orderBy: { sortOrder: 'asc' } },
            modifierGroups: {
              orderBy: { sortOrder: 'asc' },
              include: { modifiers: { where: { archivedAt: null }, orderBy: { sortOrder: 'asc' } } },
            },
          },
        },
      },
    });
  }

  /** One item with everything the storefront sheet and the editor need. */
  findDetailed(id: string) {
    return this.delegate(this.db).findUnique({
      where: { id },
      include: {
        category: true,
        variants: { where: { archivedAt: null }, orderBy: { sortOrder: 'asc' } },
        modifierGroups: {
          orderBy: { sortOrder: 'asc' },
          include: { modifiers: { where: { archivedAt: null }, orderBy: { sortOrder: 'asc' } } },
        },
      },
    });
  }

  /** FR-MENU-8: an item an order references may be archived, never deleted. */
  countOrderReferences(id: string) {
    return this.db.orderItem.count({ where: { menuItemId: id } });
  }

  /** Everything pricing_service needs to price a cart line, loaded fresh. */
  findForPricing(ids: string[]) {
    return this.delegate(this.db).findMany({
      where: { id: { in: ids }, archivedAt: null },
      include: {
        variants: true,
        modifierGroups: { include: { modifiers: true } },
      },
    });
  }

  /** Resolves an inbound WhatsApp cart line back to a menu item. */
  /**
   * Resolve inbound catalog cart lines.
   *
   * A cart's `product_retailer_id` is not reliably the retailer id we set:
   * WhatsApp sends Meta's own numeric product id for some lines and our cuid
   * for others, and both arrive in the same field. Observed live — a cart of
   * Sobo and Ginger Beer came through as 28444546298569197 and
   * 27865572773113567, which are exactly those items' `whapiProductId`.
   *
   * Matching only one column silently drops the line, and the customer is told
   * their drink is unavailable when it is sitting in stock. Both ids are ours
   * and both are unique, so both are searched.
   */
  findByCatalogIds(catalogIds: string[]) {
    return this.delegate(this.db).findMany({
      where: {
        archivedAt: null,
        OR: [{ productRetailerId: { in: catalogIds } }, { whapiProductId: { in: catalogIds } }],
      },
    });
  }

  /** Catalog sync targets: everything that should exist as a Whapi product. */
  findSyncable(branchId: string) {
    return this.delegate(this.db).findMany({
      where: { archivedAt: null, category: { branchId, archivedAt: null } },
    });
  }
}

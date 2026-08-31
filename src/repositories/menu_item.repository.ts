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
   * The public menu, in one query: active, unarchived, in sort order, with the
   * variants and modifier groups the storefront needs to render an item sheet.
   */
  findPublicMenu(branchId: string) {
    return this.db.category.findMany({
      where: { branchId, isActive: true, archivedAt: null },
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
  findByRetailerIds(retailerIds: string[]) {
    return this.delegate(this.db).findMany({
      where: { productRetailerId: { in: retailerIds }, archivedAt: null },
    });
  }

  /** Catalog sync targets: everything that should exist as a Whapi product. */
  findSyncable(branchId: string) {
    return this.delegate(this.db).findMany({
      where: { archivedAt: null, category: { branchId, archivedAt: null } },
    });
  }
}

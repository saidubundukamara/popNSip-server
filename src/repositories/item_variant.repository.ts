import type { PrismaClient } from '@/generated/prisma/client';
import type { ItemVariantModel } from '@/generated/prisma/models';
import { BaseRepository, type DbClient, type TxClient } from '@/repositories/base.repository';

export class ItemVariantRepository extends BaseRepository<PrismaClient['itemVariant'], ItemVariantModel> {
  protected delegate(db: DbClient) {
    return db.itemVariant;
  }

  withTx(tx: TxClient): this {
    return new ItemVariantRepository(tx) as this;
  }

  findForItem(menuItemId: string) {
    return this.delegate(this.db).findMany({
      where: { menuItemId, archivedAt: null },
      orderBy: { sortOrder: 'asc' },
    });
  }

  /** FR-MENU-8: a variant an order references may be archived, never deleted. */
  countOrderReferences(id: string) {
    return this.db.orderItem.count({ where: { variantId: id } });
  }
}

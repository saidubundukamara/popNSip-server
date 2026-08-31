import type { PrismaClient } from '@/generated/prisma/client';
import type { ModifierGroupModel } from '@/generated/prisma/models';
import { BaseRepository, type DbClient, type TxClient } from '@/repositories/base.repository';

export class ModifierGroupRepository extends BaseRepository<PrismaClient['modifierGroup'], ModifierGroupModel> {
  protected delegate(db: DbClient) {
    return db.modifierGroup;
  }

  withTx(tx: TxClient): this {
    return new ModifierGroupRepository(tx) as this;
  }

  findForItem(menuItemId: string) {
    return this.delegate(this.db).findMany({
      where: { menuItemId },
      orderBy: { sortOrder: 'asc' },
      include: { modifiers: { where: { archivedAt: null }, orderBy: { sortOrder: 'asc' } } },
    });
  }

  countOrderReferences(id: string) {
    return this.db.orderItemModifier.count({ where: { modifier: { modifierGroupId: id } } });
  }
}

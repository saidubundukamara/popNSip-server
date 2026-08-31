import type { PrismaClient } from '@/generated/prisma/client';
import type { ModifierModel } from '@/generated/prisma/models';
import { BaseRepository, type DbClient, type TxClient } from '@/repositories/base.repository';

export class ModifierRepository extends BaseRepository<PrismaClient['modifier'], ModifierModel> {
  protected delegate(db: DbClient) {
    return db.modifier;
  }

  withTx(tx: TxClient): this {
    return new ModifierRepository(tx) as this;
  }

  countOrderReferences(id: string) {
    return this.db.orderItemModifier.count({ where: { modifierId: id } });
  }
}

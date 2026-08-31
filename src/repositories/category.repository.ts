import type { PrismaClient } from '@/generated/prisma/client';
import type { CategoryModel } from '@/generated/prisma/models';
import { BaseRepository, type DbClient, type TxClient } from '@/repositories/base.repository';

export class CategoryRepository extends BaseRepository<PrismaClient['category'], CategoryModel> {
  protected delegate(db: DbClient) {
    return db.category;
  }

  withTx(tx: TxClient): this {
    return new CategoryRepository(tx) as this;
  }

  /** Manager view: everything still on the menu, archived rows excluded. */
  findForBranch(branchId: string) {
    return this.delegate(this.db).findMany({
      where: { branchId, archivedAt: null },
      orderBy: { sortOrder: 'asc' },
    });
  }

  /** Reordering writes the whole list in one transaction (FR-MENU-4). */
  async reorder(ids: string[], tx: TxClient): Promise<void> {
    await Promise.all(
      ids.map((id, index) => tx.category.update({ where: { id }, data: { sortOrder: index } })),
    );
  }
}

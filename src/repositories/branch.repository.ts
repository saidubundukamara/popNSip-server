import type { PrismaClient } from '@/generated/prisma/client';
import type { BranchModel } from '@/generated/prisma/models';
import { BaseRepository, type DbClient, type TxClient } from '@/repositories/base.repository';

export class BranchRepository extends BaseRepository<PrismaClient['branch'], BranchModel> {
  protected delegate(db: DbClient) {
    return db.branch;
  }

  withTx(tx: TxClient): this {
    return new BranchRepository(tx) as this;
  }

  /** v1 is single-branch; this is how everything that needs "the" branch gets it. */
  findFirst() {
    return this.delegate(this.db).findFirst({ orderBy: { createdAt: 'asc' } });
  }
}

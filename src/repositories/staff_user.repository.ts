import type { PrismaClient } from '@/generated/prisma/client';
import type { StaffUserModel } from '@/generated/prisma/models';
import { BaseRepository, type DbClient, type TxClient } from '@/repositories/base.repository';

export class StaffUserRepository extends BaseRepository<PrismaClient['staffUser'], StaffUserModel> {
  protected delegate(db: DbClient) {
    return db.staffUser;
  }

  withTx(tx: TxClient): this {
    return new StaffUserRepository(tx) as this;
  }

  /** Login. Returns inactive users too — auth_service decides, not the query. */
  findByEmail(email: string) {
    return this.delegate(this.db).findUnique({ where: { email: email.toLowerCase() } });
  }

  findForBranch(branchId: string) {
    return this.delegate(this.db).findMany({
      where: { branchId },
      orderBy: { createdAt: 'asc' },
    });
  }
}

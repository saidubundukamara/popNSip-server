import type { PrismaClient } from '@/generated/prisma/client';
import type { AuditLogModel } from '@/generated/prisma/models';
import { BaseRepository, type DbClient, type TxClient } from '@/repositories/base.repository';

export class AuditLogRepository extends BaseRepository<PrismaClient['auditLog'], AuditLogModel> {
  protected delegate(db: DbClient) {
    return db.auditLog;
  }

  withTx(tx: TxClient): this {
    return new AuditLogRepository(tx) as this;
  }

  /** The owner's audit viewer (Phase 9). */
  findRecent(take = 100) {
    return this.delegate(this.db).findMany({
      orderBy: { createdAt: 'desc' },
      take,
      include: { staffUser: { select: { id: true, name: true, email: true } } },
    });
  }
}

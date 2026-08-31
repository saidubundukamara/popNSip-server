import type { PrismaClient } from '@/generated/prisma/client';
import type { CustomerModel } from '@/generated/prisma/models';
import { BaseRepository, type DbClient, type TxClient } from '@/repositories/base.repository';

export class CustomerRepository extends BaseRepository<PrismaClient['customer'], CustomerModel> {
  protected delegate(db: DbClient) {
    return db.customer;
  }

  withTx(tx: TxClient): this {
    return new CustomerRepository(tx) as this;
  }

  findByPhone(phoneE164: string) {
    return this.delegate(this.db).findUnique({ where: { phoneE164 } });
  }

  /** Phone is the identity; a name given later fills in a blank, never overwrites. */
  upsertByPhone(phoneE164: string, name?: string) {
    return this.delegate(this.db).upsert({
      where: { phoneE164 },
      create: { phoneE164, ...(name ? { name } : {}) },
      update: name ? { name } : {},
    });
  }

  search(term: string, take = 25) {
    return this.delegate(this.db).findMany({
      where: {
        OR: [
          { phoneE164: { contains: term } },
          { name: { contains: term, mode: 'insensitive' } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take,
    });
  }
}

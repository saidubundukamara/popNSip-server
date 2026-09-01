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

  /** The customer list's default view: whoever was here most recently. */
  recent(take = 50) {
    return this.delegate(this.db).findMany({ orderBy: { updatedAt: 'desc' }, take });
  }

  /**
   * Name or phone. The phone arm takes an already-normalised fragment, since
   * the column holds E.164 and staff type a local number.
   */
  searchByNameOrPhone(term: string, phoneFragment?: string, take = 50) {
    return this.delegate(this.db).findMany({
      where: {
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { phoneE164: { contains: phoneFragment ?? term } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take,
    });
  }

  findByIdWithOrders(id: string, take = 20) {
    return this.delegate(this.db).findUnique({
      where: { id },
      include: {
        orders: {
          orderBy: { placedAt: 'desc' },
          take,
          include: { items: { include: { modifiers: true } }, payments: true, table: true },
        },
      },
    });
  }
}

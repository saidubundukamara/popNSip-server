import type { PrismaClient } from '@/generated/prisma/client';
import type { OrderAdjustmentModel } from '@/generated/prisma/models';
import { BaseRepository, type DbClient, type TxClient } from '@/repositories/base.repository';

export class OrderAdjustmentRepository extends BaseRepository<
  PrismaClient['orderAdjustment'],
  OrderAdjustmentModel
> {
  protected delegate(db: DbClient) {
    return db.orderAdjustment;
  }

  withTx(tx: TxClient): this {
    return new OrderAdjustmentRepository(tx) as this;
  }

  findForOrder(orderId: string) {
    return this.delegate(this.db).findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
  }

  /** The order's adjustmentsMinor is this sum; it is never accumulated by hand. */
  async sumForOrder(orderId: string, tx?: TxClient): Promise<number> {
    const db = tx ?? this.db;
    const result = await db.orderAdjustment.aggregate({ where: { orderId }, _sum: { amountMinor: true } });
    return result._sum.amountMinor ?? 0;
  }
}

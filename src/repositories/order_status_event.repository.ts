import type { PrismaClient } from '@/generated/prisma/client';
import type { OrderStatusEventModel } from '@/generated/prisma/models';
import { BaseRepository, type DbClient, type TxClient } from '@/repositories/base.repository';

export class OrderStatusEventRepository extends BaseRepository<
  PrismaClient['orderStatusEvent'],
  OrderStatusEventModel
> {
  protected delegate(db: DbClient) {
    return db.orderStatusEvent;
  }

  withTx(tx: TxClient): this {
    return new OrderStatusEventRepository(tx) as this;
  }

  /** The order's history, oldest first — what the tracking page renders. */
  findForOrder(orderId: string) {
    return this.delegate(this.db).findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
  }
}

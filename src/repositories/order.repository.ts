import { OrderStatus } from '@/generated/prisma/enums';
import type { OrderModel } from '@/generated/prisma/models';
import type { PrismaClient } from '@/generated/prisma/client';
import { BaseRepository, type DbClient, type TxClient } from '@/repositories/base.repository';

/** Everything the POS queue considers live. Terminal statuses are excluded. */
export const OPEN_STATUSES = [
  OrderStatus.AWAITING_PAYMENT,
  OrderStatus.PENDING_CONFIRMATION,
  OrderStatus.CONFIRMED,
  OrderStatus.PREPARING,
  OrderStatus.READY,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.SERVED,
] as const;

export class OrderRepository extends BaseRepository<PrismaClient['order'], OrderModel> {
  protected delegate(db: DbClient) {
    return db.order;
  }

  withTx(tx: TxClient): this {
    return new OrderRepository(tx) as this;
  }

  /** The public tracking page. Everything it renders, in one query. */
  findByTrackingToken(token: string) {
    return this.delegate(this.db).findUnique({
      where: { trackingToken: token },
      include: { items: { include: { modifiers: true } }, payments: true, adjustments: true },
    });
  }

  findByReference(reference: string) {
    return this.delegate(this.db).findUnique({ where: { reference } });
  }

  /** FR-SHOP-10: a retried checkout resolves to the order it already created. */
  findByIdempotencyKey(key: string) {
    return this.delegate(this.db).findUnique({ where: { idempotencyKey: key } });
  }

  /** The POS queue. One query, served by the (branchId, status, placedAt) index. */
  findOpenForBranch(branchId: string) {
    return this.delegate(this.db).findMany({
      where: { branchId, status: { in: [...OPEN_STATUSES] } },
      orderBy: { placedAt: 'desc' },
      include: { items: { include: { modifiers: true } }, customer: true, payments: true, table: true },
    });
  }

  /** Candidates for jobs/expire_orders and jobs/reconcile_payments. */
  findExpiredAwaitingPayment(now: Date) {
    return this.delegate(this.db).findMany({
      where: { status: OrderStatus.AWAITING_PAYMENT, expiresAt: { lt: now } },
      include: { payments: true },
    });
  }
}

import { PaymentStatus } from '@/generated/prisma/enums';
import type { PrismaClient } from '@/generated/prisma/client';
import type { PaymentModel } from '@/generated/prisma/models';
import { BaseRepository, type DbClient, type TxClient } from '@/repositories/base.repository';

export class PaymentRepository extends BaseRepository<PrismaClient['payment'], PaymentModel> {
  protected delegate(db: DbClient) {
    return db.payment;
  }

  withTx(tx: TxClient): this {
    return new PaymentRepository(tx) as this;
  }

  /** Monime echoes `reference: order.id`, so a webhook finds its row directly. */
  findByProviderRef(provider: string, providerRef: string) {
    return this.delegate(this.db).findUnique({ where: { provider_providerRef: { provider, providerRef } } });
  }

  findForOrder(orderId: string) {
    return this.delegate(this.db).findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
  }

  /** What the order has actually been paid. Drives balanceDue. */
  async sumSettledForOrder(orderId: string): Promise<number> {
    const result = await this.db.payment.aggregate({
      where: { orderId, status: PaymentStatus.SUCCEEDED },
      _sum: { amountMinor: true },
    });
    return result._sum.amountMinor ?? 0;
  }
}

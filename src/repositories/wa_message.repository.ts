import { MessageStatus } from '@/generated/prisma/enums';
import type { PrismaClient } from '@/generated/prisma/client';
import type { WhatsAppMessageModel } from '@/generated/prisma/models';
import { BaseRepository, type DbClient, type TxClient } from '@/repositories/base.repository';

export class WhatsAppMessageRepository extends BaseRepository<
  PrismaClient['whatsAppMessage'],
  WhatsAppMessageModel
> {
  protected delegate(db: DbClient) {
    return db.whatsAppMessage;
  }

  withTx(tx: TxClient): this {
    return new WhatsAppMessageRepository(tx) as this;
  }

  /**
   * The send queue, oldest first, excluding anything that has failed too often
   * to be worth another attempt.
   */
  findSendable(maxAttempts: number, take = 50) {
    return this.delegate(this.db).findMany({
      where: { status: MessageStatus.QUEUED, attempts: { lt: maxAttempts } },
      orderBy: { createdAt: 'asc' },
      take,
      include: { conversation: true },
    });
  }

  findForOrder(orderId: string) {
    return this.delegate(this.db).findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
  }
}

import type { PrismaClient } from '@/generated/prisma/client';
import type { WhatsAppConversationModel } from '@/generated/prisma/models';
import { BaseRepository, type DbClient, type TxClient } from '@/repositories/base.repository';

export class WhatsAppConversationRepository extends BaseRepository<
  PrismaClient['whatsAppConversation'],
  WhatsAppConversationModel
> {
  protected delegate(db: DbClient) {
    return db.whatsAppConversation;
  }

  withTx(tx: TxClient): this {
    return new WhatsAppConversationRepository(tx) as this;
  }

  /** The live session for a number, if it has not aged out (30 min). */
  findActiveByPhone(phoneE164: string, now: Date) {
    return this.delegate(this.db).findFirst({
      where: { phoneE164, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Conversations a human needs to pick up (FR-WA-9). */
  findNeedingHuman() {
    return this.delegate(this.db).findMany({
      where: { needsHuman: true },
      orderBy: { lastInboundAt: 'desc' },
    });
  }
}

import type { PrismaClient } from '@/generated/prisma/client';
import type { WebhookEventModel } from '@/generated/prisma/models';
import { BaseRepository, type DbClient, type TxClient } from '@/repositories/base.repository';

export class WebhookEventRepository extends BaseRepository<PrismaClient['webhookEvent'], WebhookEventModel> {
  protected delegate(db: DbClient) {
    return db.webhookEvent;
  }

  withTx(tx: TxClient): this {
    return new WebhookEventRepository(tx) as this;
  }

  /**
   * Claim an event for processing. Returns null when this id has been seen
   * before, which is what makes a replayed webhook credit once (FR-PAY-5).
   * The unique constraint does the work — a SELECT-then-INSERT would race.
   */
  async claim(input: {
    provider: string;
    providerEventId: string;
    eventName: string;
    payload: object;
  }): Promise<WebhookEventModel | null> {
    const created = await this.delegate(this.db).createMany({
      data: [input],
      skipDuplicates: true,
    });
    if (created.count === 0) return null;
    return this.delegate(this.db).findUnique({ where: { providerEventId: input.providerEventId } });
  }

  markProcessed(id: string, error?: string) {
    return this.delegate(this.db).update({
      where: { id },
      data: { processedAt: new Date(), ...(error ? { error } : {}) },
    });
  }
}

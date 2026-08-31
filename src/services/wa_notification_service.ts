import { MessageDirection, MessageStatus, OrderStatus, OrderType } from '@/generated/prisma/enums';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import { sendText } from '@/lib/whapi';
import { repositories as repos } from '@/repositories';

/**
 * Outbound order notifications (FR-WA-3, FR-WA-8).
 *
 * Whapi is not the Meta Cloud API, so there is no 24-hour window and no
 * template approval — these are plain sends. They are still queued rather than
 * sent inline, for one reason: a status transition must never fail because
 * WhatsApp was slow. The queue is what makes "notify the customer" a thing
 * that happens *after* the order moved, not a thing the order waits on.
 */

const MAX_ATTEMPTS = 5;

/** Exponential, capped. Attempt n waits roughly 2^n minutes. */
const backoffMs = (attempts: number): number => Math.min(2 ** attempts * 60_000, 30 * 60_000);

export type QueueInput = {
  phoneE164: string;
  body: string;
  kind: string;
  conversationId?: string | null;
  orderId?: string | null;
  templateName?: string | null;
};

/** Put a message on the queue. Never throws — the caller is mid-transition. */
export async function queueMessage(input: QueueInput): Promise<void> {
  try {
    await repos.waMessages.create({
      conversationId: input.conversationId ?? null,
      orderId: input.orderId ?? null,
      direction: MessageDirection.OUTBOUND,
      kind: input.kind,
      templateName: input.templateName ?? null,
      body: input.body,
      status: MessageStatus.QUEUED,
    });
  } catch (error) {
    // A notification we failed to even queue is worth a loud log and nothing
    // more. The order has already moved.
    logger.error({ err: error, kind: input.kind }, 'Could not queue a WhatsApp message');
  }
}

/** Record an inbound message, for the conversation view staff will read. */
export async function recordInbound(input: {
  conversationId: string;
  kind: string;
  body?: string | null;
  providerMessageId?: string | null;
}): Promise<void> {
  try {
    await repos.waMessages.create({
      conversationId: input.conversationId,
      direction: MessageDirection.INBOUND,
      kind: input.kind,
      body: input.body ?? null,
      providerMessageId: input.providerMessageId ?? null,
      status: MessageStatus.SENT,
    });
  } catch (error) {
    logger.warn({ err: error }, 'Could not record an inbound WhatsApp message');
  }
}

/**
 * Send what a message queued to the customer immediately, and queue it as a
 * record either way.
 *
 * Conversation replies go out inline — a bot that answers on a one-minute
 * queue is not a conversation — while order notifications go through the
 * queue, where a retry costs nobody anything.
 */
export async function sendNow(input: QueueInput): Promise<boolean> {
  const result = await sendText(input.phoneE164, input.body);

  try {
    await repos.waMessages.create({
      conversationId: input.conversationId ?? null,
      orderId: input.orderId ?? null,
      direction: MessageDirection.OUTBOUND,
      kind: input.kind,
      body: input.body,
      status: result.ok ? MessageStatus.SENT : MessageStatus.QUEUED,
      attempts: 1,
      ...(result.ok ? { sentAt: new Date() } : { error: result.error }),
    });
  } catch (error) {
    logger.warn({ err: error }, 'Could not record an outbound WhatsApp message');
  }

  return result.ok;
}

// ─── order notifications ──────────────────────────────────────────────────

const trackUrl = (token: string): string => `${env.APP_BASE_URL}/orders/track/${token}`;

/**
 * What the customer is told at each step. Statuses not listed here are
 * internal and deliberately silent — a customer does not need to know an
 * order moved from CONFIRMED to PREPARING twice because a tablet was tapped.
 */
function notificationFor(input: {
  status: OrderStatus;
  type: OrderType;
  reference: string;
  trackingToken: string;
}): string | null {
  const track = trackUrl(input.trackingToken);

  switch (input.status) {
    case OrderStatus.CONFIRMED:
      return `Your order *${input.reference}* is confirmed and we have started on it.\n\nFollow it here: ${track}`;
    case OrderStatus.READY:
      return input.type === OrderType.DELIVERY
        ? `Order *${input.reference}* is ready and waiting for a rider.`
        : `Order *${input.reference}* is ready for collection.`;
    case OrderStatus.OUT_FOR_DELIVERY:
      return `Order *${input.reference}* is on its way to you.`;
    case OrderStatus.COMPLETED:
      return `Order *${input.reference}* is complete. Thank you — we hope to see you again.`;
    case OrderStatus.CANCELLED:
      return `Order *${input.reference}* has been cancelled. If that is unexpected, reply here and a person will help.`;
    default:
      return null;
  }
}

/** Called by order_status_service after a transition commits. */
export async function notifyOrderStatus(order: {
  id: string;
  reference: string;
  status: OrderStatus;
  type: OrderType;
  trackingToken: string;
  customerId: string | null;
}): Promise<void> {
  const body = notificationFor(order);
  if (!body || !order.customerId) return;

  const customer = await repos.customers.findById(order.customerId);
  if (!customer || customer.marketingOptOut) return;

  await queueMessage({
    phoneE164: customer.phoneE164,
    body,
    kind: 'order_status',
    orderId: order.id,
    templateName: `order.${order.status.toLowerCase()}`,
  });
}

// ─── the queue worker ─────────────────────────────────────────────────────

export type FlushResult = { sent: number; failed: number; skipped: number };

/**
 * Drain the queue (jobs/flush_wa_queue).
 *
 * A message that has failed its last attempt is marked FAILED and left alone:
 * retrying forever turns a bad number into an infinite log.
 */
export async function flushQueue(now: Date = new Date()): Promise<FlushResult> {
  const result: FlushResult = { sent: 0, failed: 0, skipped: 0 };

  const queued = await repos.waMessages.findSendable(MAX_ATTEMPTS);

  for (const message of queued) {
    // Respect the backoff without needing a scheduled-at column: the row's own
    // age and attempt count say when it is next due.
    const due = new Date(message.createdAt.getTime() + backoffMs(message.attempts));
    if (message.attempts > 0 && due > now) {
      result.skipped += 1;
      continue;
    }

    const phoneE164 = message.conversation?.phoneE164 ?? (await phoneForOrder(message.orderId));
    if (!phoneE164 || !message.body) {
      await repos.waMessages.update(message.id, {
        status: MessageStatus.FAILED,
        error: 'No recipient or body',
      });
      result.failed += 1;
      continue;
    }

    const attempts = message.attempts + 1;
    const sent = await sendText(phoneE164, message.body);

    if (sent.ok) {
      await repos.waMessages.update(message.id, {
        status: MessageStatus.SENT,
        attempts,
        sentAt: new Date(),
        error: null,
      });
      result.sent += 1;
      continue;
    }

    await repos.waMessages.update(message.id, {
      status: attempts >= MAX_ATTEMPTS ? MessageStatus.FAILED : MessageStatus.QUEUED,
      attempts,
      error: sent.error,
    });
    result.failed += 1;
  }

  if (result.sent > 0 || result.failed > 0) logger.info(result, 'WhatsApp queue flushed');
  return result;
}

async function phoneForOrder(orderId: string | null): Promise<string | null> {
  if (!orderId) return null;
  const order = await repos.orders.findByIdDetailed(orderId);
  return order?.customer?.phoneE164 ?? null;
}

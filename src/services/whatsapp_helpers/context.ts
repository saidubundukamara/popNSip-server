import type { BranchModel, WhatsAppConversationModel } from '@/generated/prisma/models';
import { sendInteractive, sendText } from '@/lib/whapi';
import type { WhapiInboundMessage, WhapiInteractivePayload } from '@/lib/whapi_types';
import { recordInbound } from '@/services/wa_notification_service';
import { repositories as repos } from '@/repositories';
import { MessageDirection, MessageStatus } from '@/generated/prisma/enums';
import { logger } from '@/lib/logger';
import type { PendingLine } from '@/services/whatsapp_helpers/cart_state';

/** Everything a handler needs, assembled once per inbound message. */
export type BotContext = {
  message: WhapiInboundMessage;
  phoneE164: string;
  customerName: string;
  conversation: WhatsAppConversationModel;
  branch: BranchModel;
  /** The selection the customer made, with the transport prefix removed. */
  selection: string | null;
  text: string | null;
};

/** Session metadata, named so handlers stop guessing at key strings. */
export type SessionData = {
  lines?: PendingLine[];
  orderType?: 'DELIVERY' | 'PICKUP' | 'DINE_IN';
  deliveryAddress?: string;
  deliveryNotes?: string;
  tableCode?: string;
  /** Which line and group the last question was about, so the answer lands right. */
  asking?: { kind: 'variant' | 'group'; lineIndex: number; groupId?: string };
  browseCategoryId?: string;
  /**
   * How this order was built. A catalog cart is already a finished shopping
   * trip — the customer picked from the grid and pressed send — so offering
   * "Add more" is a button that does nothing they cannot do better by opening
   * the catalog again. An order assembled through the chat has no such place
   * to go back to, so there it earns its keep.
   */
  cartOrigin?: 'catalog' | 'conversation';
};

/**
 * Reply to the customer.
 *
 * Conversation replies go out inline rather than through the notification
 * queue: a bot that answers a minute later is not a conversation. The row is
 * still written so staff reading the thread see both sides.
 */
export async function reply(context: BotContext, body: string): Promise<void> {
  const result = await sendText(context.phoneE164, body);
  await record(context, 'text', body, result.ok);
}

export async function replyInteractive(
  context: BotContext,
  payload: WhapiInteractivePayload,
  summary: string,
): Promise<void> {
  const result = await sendInteractive(payload);
  await record(context, payload.type, summary, result.ok);
}

async function record(context: BotContext, kind: string, body: string, sent: boolean): Promise<void> {
  try {
    await repos.waMessages.create({
      conversationId: context.conversation.id,
      direction: MessageDirection.OUTBOUND,
      kind,
      body,
      status: sent ? MessageStatus.SENT : MessageStatus.FAILED,
      attempts: 1,
      ...(sent ? { sentAt: new Date() } : { error: 'Whapi rejected the send' }),
    });
  } catch (error) {
    logger.warn({ err: error }, 'Could not record a bot reply');
  }
}

export { recordInbound };

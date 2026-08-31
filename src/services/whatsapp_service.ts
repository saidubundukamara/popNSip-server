import { logger } from '@/lib/logger';
import { HANDED_TO_HUMAN, HELP_TEXT, buttonMessage, greeting } from '@/lib/whapi_templates';
import type { WhapiWebhookBody } from '@/lib/whapi_types';
import {
  extractSelection,
  extractTextInput,
  inboundMessageOf,
  isCartMessage,
  parseGlobalCommand,
  toE164,
} from '@/lib/whatsapp_utils';
import { repositories as repos } from '@/repositories';
import {
  BotSessionAccumulator,
  resolveSession,
  sessionExpiryFrom,
  updateSession,
  withSession,
  type BotIntent,
} from '@/services/bot_session_service';
import { recordInbound } from '@/services/wa_notification_service';
import type { BotContext, SessionData } from '@/services/whatsapp_helpers/context';
import { reply, replyInteractive } from '@/services/whatsapp_helpers/context';
import { handleCart, showCartForReview } from '@/services/whatsapp_helpers/handle_cart';
import { handleBrowseReply, startBrowse } from '@/services/whatsapp_helpers/handle_browse';
import {
  askOrderType,
  handleAddressReply,
  handleOrderTypeReply,
  handlePaymentReply,
} from '@/services/whatsapp_helpers/handle_checkout';
import { handleConfigureReply } from '@/services/whatsapp_helpers/handle_configure';

/**
 * The bot's entry point, mirroring byn2_v2's `init`: pull the message out,
 * resolve the session, honour global commands, then dispatch on intent.
 *
 * Every handler runs inside `withSession`, so one inbound message causes one
 * session write no matter how many times a handler touches it.
 */

export async function init(body: WhapiWebhookBody): Promise<void> {
  const message = inboundMessageOf(body);
  if (!message?.from) return;

  const phoneE164 = toE164(message.from);
  const branch = await repos.branches.findFirst();
  if (!branch) {
    logger.error('WhatsApp message received but no branch is configured');
    return;
  }

  const now = new Date();
  const conversation = await resolveSession(phoneE164, now);

  const context: BotContext = {
    message,
    phoneE164,
    customerName: message.from_name?.trim() || 'WhatsApp customer',
    conversation,
    branch,
    selection: extractSelection(message),
    text: extractTextInput(message),
  };

  const accumulator = new BotSessionAccumulator(
    conversation.id,
    (conversation.metadata ?? {}) as Record<string, unknown>,
  );

  await withSession(accumulator, async () => {
    // Every inbound message extends the session, whatever else happens to it.
    updateSession({ lastInboundAt: now, expiresAt: sessionExpiryFrom(now) });

    await recordInbound({
      conversationId: conversation.id,
      kind: message.type ?? 'text',
      // The body is stored for staff to read; a cart's base64 preview is not.
      body: isCartMessage(message) ? '[catalog cart]' : context.text,
      providerMessageId: message.id ?? null,
    });

    await route(context, accumulator.metadata() as SessionData);
  });
}

async function route(context: BotContext, data: SessionData): Promise<void> {
  // ── escalated: the bot stays out of the way ──
  if (context.conversation.needsHuman) {
    const command = parseGlobalCommand(context.text);
    if (command !== 'restart' && command !== 'menu') return;
    updateSession({ needsHuman: false });
  }

  // ── global commands, at any step ──
  const command = parseGlobalCommand(context.text);
  if (command) {
    await handleGlobalCommand(context, command);
    return;
  }

  // ── welcome-screen buttons ──
  // These arrive as a selection, not text, so parseGlobalCommand never sees
  // them; without this the Help button quietly opens the browse list.
  if (context.selection === 'browse') {
    await startBrowse(context);
    return;
  }
  if (context.selection === 'help') {
    await reply(context, HELP_TEXT);
    return;
  }

  // ── a catalog cart interrupts anything ──
  // Someone who sends a cart mid-question has decided what they want; asking
  // them to finish the old question first would be obstinate.
  if (isCartMessage(context.message)) {
    await handleCart(context, data);
    return;
  }

  const intent = (context.conversation.intent ?? 'start') as BotIntent;

  switch (intent) {
    case 'configure_item':
      await handleConfigureReply(context, data);
      return;

    case 'cart_review':
      await handleCartReview(context, data);
      return;

    case 'order_type':
      await handleOrderTypeReply(context);
      return;

    case 'address':
      await handleAddressReply(context, data);
      return;

    case 'payment':
      await handlePaymentReply(context, data);
      return;

    case 'browse':
      await handleBrowseReply(context, data);
      return;

    case 'human':
      return;

    case 'start':
    default:
      await welcome(context);
  }
}

async function handleCartReview(context: BotContext, data: SessionData): Promise<void> {
  switch (context.selection) {
    case 'cart_confirm':
      await askOrderType(context);
      return;

    case 'cart_add_more':
      await startBrowse(context);
      return;

    case 'cart_cancel':
      updateSession({ intent: 'start', step: null, metadata: { lines: [] } });
      await reply(context, 'No problem — I have cleared that. Type *menu* when you are ready.');
      return;

    default:
      // Anything else at this step: show them where they are rather than
      // repeating a question they may not have seen.
      await showCartForReview(context, data.lines ?? []);
  }
}

async function handleGlobalCommand(
  context: BotContext,
  command: NonNullable<ReturnType<typeof parseGlobalCommand>>,
): Promise<void> {
  switch (command) {
    case 'menu':
      await welcome(context);
      return;

    case 'help':
      await reply(context, HELP_TEXT);
      return;

    case 'cancel':
    case 'restart':
      updateSession({ intent: 'start', step: null, metadata: { lines: [], orderType: undefined } });
      await reply(context, 'Cleared. Type *menu* whenever you would like to order.');
      return;

    case 'human':
      updateSession({ needsHuman: true, intent: 'human', step: null });
      await reply(context, HANDED_TO_HUMAN);
      return;
  }
}

async function welcome(context: BotContext): Promise<void> {
  updateSession({ intent: 'start', step: null });

  const customer = await repos.customers.findByPhone(context.phoneE164);

  await replyInteractive(
    context,
    buttonMessage({
      phoneE164: context.phoneE164,
      body: `${greeting(context.branch.name, customer?.name)}\n\nSend me a cart from our catalogue, or browse here.`,
      buttons: [
        { id: 'browse', title: 'Browse the menu' },
        { id: 'help', title: 'Help' },
      ],
    }),
    'Welcome',
  );

  // The welcome buttons are answered on the next message, so the intent has to
  // be one that knows what to do with them.
  updateSession({ intent: 'browse', step: 'category' });
}

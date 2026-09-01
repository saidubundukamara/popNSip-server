import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import { HANDED_TO_HUMAN, HELP_TEXT, buttonMessage, catalogLink, greeting } from '@/lib/whapi_templates';
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

  // ── the cart buttons answer for themselves ──
  // WhatsApp lets a customer tap a button on any message still on their
  // screen, not only the most recent one. Routing every selection by the
  // current intent therefore breaks the moment they scroll: tap "Add more",
  // land in browsing, then tap "Confirm" on the message above it, and the
  // browse handler gets a word it does not know and asks what you are in the
  // mood for — indistinguishable from the tap being ignored.
  //
  // These three ids mean one thing each, whenever there is an order to act on,
  // so they are honoured wherever they arrive from.
  const cartActions = ['cart_confirm', 'cart_add_more', 'cart_cancel'];
  if (context.selection && cartActions.includes(context.selection) && (data.lines?.length ?? 0) > 0) {
    await handleCartReview(context, data);
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
      await showCartForReview(context, data.lines ?? [], data.cartOrigin ?? 'catalog');
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
  // Starting over means starting over. Without this, an order abandoned
  // half-configured survives the greeting, and the next cart merges into it —
  // send a bottle of water after walking away from a jollof rice, and the bot
  // answers "Which size of Jollof Rice?", which is baffling and looks like it
  // ignored what you just sent.
  //
  // The 30-minute session expiry does not cover this: the customer is back
  // within the window, deliberately restarting, and saying so.
  updateSession({ intent: 'start', step: null, metadata: { lines: [], asking: undefined } });

  const customer = await repos.customers.findByPhone(context.phoneE164);

  await replyInteractive(
    context,
    buttonMessage({
      phoneE164: context.phoneE164,
      // WHAPI_NUMBER is optional outside production, and a deployment without
      // one must not offer a link to wa.me/c/undefined.
      body: [
        greeting(context.branch.name, customer?.name),
        '',
        ...(env.WHAPI_NUMBER
          ? [
              'Tap to see the menu with pictures, add what you want, and send the cart back to me:',
              catalogLink(env.WHAPI_NUMBER),
              '',
              'Or use the buttons below.',
            ]
          : ['Send me a cart from our catalogue, or browse here.']),
      ].join('\n'),
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

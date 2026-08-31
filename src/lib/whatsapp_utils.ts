import type { WhapiInboundMessage, WhapiWebhookBody } from '@/lib/whapi_types';

/**
 * Extractors and input handling, lifted from byn2_v2 with one correction.
 */

// ─── extractors ───────────────────────────────────────────────────────────

export const extractButtonId = (message: WhapiInboundMessage): string | null =>
  message.reply?.buttons_reply?.id ?? null;

export const extractListId = (message: WhapiInboundMessage): string | null =>
  message.reply?.list_reply?.id ?? null;

export const extractTextInput = (message: WhapiInboundMessage): string | null =>
  message.text?.body?.trim() || null;

/**
 * A row sent as `id: 'cat_rice'` comes back as `ListV3:cat_rice`; a button as
 * `ButtonsV3:confirm`.
 *
 * byn2_v2 handles this by matching the prefixed form in every switch, which
 * scatters `ListV3:` literals through the handlers and means a prefix change
 * breaks the bot in a dozen places at once. Strip it here instead, so every
 * handler compares against the id it actually sent.
 */
export function stripReplyPrefix(id: string | null): string | null {
  if (!id) return null;
  const separator = id.indexOf(':');
  return separator === -1 ? id : id.slice(separator + 1);
}

/** Any selection the customer made, with the transport prefix removed. */
export const extractSelection = (message: WhapiInboundMessage): string | null =>
  stripReplyPrefix(extractListId(message) ?? extractButtonId(message));

// ─── global commands ──────────────────────────────────────────────────────

export const GLOBAL_COMMANDS = {
  menu: 'menu',
  help: 'help',
  cancel: 'cancel',
  restart: 'restart',
  human: 'human',
} as const;

export type GlobalCommand = (typeof GLOBAL_COMMANDS)[keyof typeof GLOBAL_COMMANDS];

/**
 * Accepts both `/menu` and `menu`: people type what feels natural, and a bot
 * that only answers the slash form looks broken to everyone else.
 */
export function parseGlobalCommand(text: string | null): GlobalCommand | null {
  if (!text) return null;

  const normalised = text.trim().toLowerCase().replace(/^\//, '');
  const aliases: Record<string, GlobalCommand> = {
    menu: GLOBAL_COMMANDS.menu,
    start: GLOBAL_COMMANDS.menu,
    hi: GLOBAL_COMMANDS.menu,
    hello: GLOBAL_COMMANDS.menu,
    help: GLOBAL_COMMANDS.help,
    cancel: GLOBAL_COMMANDS.cancel,
    stop: GLOBAL_COMMANDS.cancel,
    restart: GLOBAL_COMMANDS.restart,
    reset: GLOBAL_COMMANDS.restart,
    human: GLOBAL_COMMANDS.human,
    agent: GLOBAL_COMMANDS.human,
    support: GLOBAL_COMMANDS.human,
  };

  return aliases[normalised] ?? null;
}

// ─── message classification ───────────────────────────────────────────────

/** A native catalog cart. The primary path (IMPLEMENTATION.md §0.1). */
export const isCartMessage = (message: WhapiInboundMessage): boolean =>
  message.type === 'order' && Boolean(message.order?.order_id);

/**
 * Whether this webhook carries anything worth acting on.
 *
 * Whapi delivers status updates and read receipts on the same URL. Answering
 * those with work is how a bot ends up replying to its own delivery receipts.
 */
export function inboundMessageOf(body: WhapiWebhookBody): WhapiInboundMessage | null {
  const message = body.messages?.[0];
  if (!message) return null;
  // Our own outbound messages come back on the same webhook.
  if (message.from_me) return null;
  if (!message.from) return null;
  return message;
}

/**
 * Whapi gives digits only; everything below the boundary stores E.164.
 */
export const toE164 = (whapiNumber: string): string =>
  whapiNumber.startsWith('+') ? whapiNumber : `+${whapiNumber.replace(/\D/g, '')}`;

/** Never log this. Base64 image data on an inbound cart. */
export function withoutPreview<T extends { preview?: unknown }>(order: T): Omit<T, 'preview'> {
  const { preview: _preview, ...rest } = order;
  return rest;
}

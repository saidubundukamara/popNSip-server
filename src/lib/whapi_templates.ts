import { toWhapiNumber } from '@/lib/phone';
import { formatMinor } from '@/lib/money';
import type { WhapiInteractivePayload, WhapiListRow, WhapiListSection } from '@/lib/whapi_types';

/**
 * Outbound message builders.
 *
 * The payload shape is byn2_v2's, which works; the content is entirely
 * popNsip's. Ids are sent bare — WhatsApp adds `ListV3:` / `ButtonsV3:` on the
 * way back and `stripReplyPrefix` takes it off again.
 */

/** WhatsApp's own limits. Exceeding either is a silent send failure. */
export const MAX_ROWS_PER_LIST = 10;
export const MAX_BUTTONS = 3;
const MAX_TITLE = 24;
const MAX_DESCRIPTION = 72;

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;

export function listMessage(input: {
  phoneE164: string;
  body: string;
  label: string;
  sections: WhapiListSection[];
  header?: string;
  footer?: string;
}): WhapiInteractivePayload {
  return {
    to: toWhapiNumber(input.phoneE164),
    type: 'list',
    ...(input.header ? { header: { text: input.header } } : {}),
    body: { text: input.body },
    ...(input.footer ? { footer: { text: input.footer } } : {}),
    // action.list, not a flat action: the label and sections nest one level
    // deeper than they read like they should (IMPLEMENTATION.md §4.1).
    action: {
      list: {
        label: truncate(input.label, MAX_TITLE),
        sections: input.sections.map((section) => ({
          title: truncate(section.title, MAX_TITLE),
          rows: section.rows.slice(0, MAX_ROWS_PER_LIST).map((row) => ({
            id: row.id,
            title: truncate(row.title, MAX_TITLE),
            ...(row.description ? { description: truncate(row.description, MAX_DESCRIPTION) } : {}),
          })),
        })),
      },
    },
  };
}

export function buttonMessage(input: {
  phoneE164: string;
  body: string;
  buttons: { id: string; title: string }[];
  header?: string;
  footer?: string;
}): WhapiInteractivePayload {
  return {
    to: toWhapiNumber(input.phoneE164),
    type: 'button',
    ...(input.header ? { header: { text: input.header } } : {}),
    body: { text: input.body },
    ...(input.footer ? { footer: { text: input.footer } } : {}),
    action: {
      buttons: input.buttons.slice(0, MAX_BUTTONS).map((button) => ({
        type: 'quick_reply' as const,
        id: button.id,
        title: truncate(button.title, MAX_TITLE),
      })),
    },
  };
}

/** Rows built from anything with an id and a name. */
export const rowsFrom = <T extends { id: string; name: string }>(
  items: T[],
  describe?: (item: T) => string | undefined,
): WhapiListRow[] =>
  items.map((item) => ({
    id: item.id,
    title: item.name,
    ...(describe?.(item) ? { description: describe(item)! } : {}),
  }));

// ─── copy ─────────────────────────────────────────────────────────────────

export const greeting = (branchName: string, customerName?: string | null): string =>
  customerName
    ? `Hello ${customerName.split(' ')[0]} — welcome back to ${branchName}.`
    : `Hello, and welcome to ${branchName}.`;

export const HELP_TEXT = [
  'Here is what I can do:',
  '',
  '• Send me a cart from our catalogue and I will take it from there.',
  '• Type *menu* to browse.',
  '• Type *cancel* to stop the current order.',
  '• Type *human* to reach a person.',
].join('\n');

export const cartSummary = (
  lines: { name: string; quantity: number; lineTotalMinor: number }[],
  totalMinor: number,
  currency: string,
): string =>
  [
    '*Your order*',
    ...lines.map((line) => `${line.quantity}× ${line.name} — ${formatMinor(line.lineTotalMinor, currency)}`),
    '',
    `Total: *${formatMinor(totalMinor, currency)}*`,
  ].join('\n');

export const droppedLinesNotice = (names: string[]): string =>
  names.length === 1
    ? `${names[0]} is not available right now, so I have left it out.`
    : `These are not available right now, so I have left them out: ${names.join(', ')}.`;

export const orderPlaced = (reference: string, trackUrl: string): string =>
  [
    `Thank you — your order *${reference}* is with the kitchen.`,
    '',
    `Follow it here: ${trackUrl}`,
  ].join('\n');

export const ussdInstruction = (ussdCode: string, amountMinor: number, currency: string): string =>
  [
    `To pay ${formatMinor(amountMinor, currency)}, dial:`,
    '',
    `*${ussdCode}*`,
    '',
    'I will let you know as soon as it comes through.',
  ].join('\n');

export const SOMETHING_WENT_WRONG =
  'Sorry, something went wrong on our side. Please try again, or type *menu* to start over.';

export const HANDED_TO_HUMAN =
  'I have passed this to a person from the restaurant. They will reply here shortly.';

export const CLOSED_NOTICE = (branchName: string): string =>
  `${branchName} is closed at the moment. You are welcome to build an order and send it when we reopen.`;

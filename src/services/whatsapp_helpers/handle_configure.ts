import { formatMinor } from '@/lib/money';
import { listMessage } from '@/lib/whapi_templates';
import { repositories as repos } from '@/repositories';
import { updateSession } from '@/services/bot_session_service';
import {
  applyAnswer,
  nextQuestion,
  type ItemRequirements,
  type PendingLine,
  type Question,
} from '@/services/whatsapp_helpers/cart_state';
import { replyInteractive, type BotContext, type SessionData } from '@/services/whatsapp_helpers/context';
import { showCartForReview } from '@/services/whatsapp_helpers/handle_cart';

/**
 * Asking the customer for the choices a catalog cart cannot carry.
 *
 * One question per message, in menu order, so the thread reads like someone
 * taking an order rather than a form.
 */

export async function loadRequirements(menuItemIds: string[]): Promise<Map<string, ItemRequirements>> {
  const items = await repos.menuItems.findForPricing([...new Set(menuItemIds)]);

  return new Map(
    items.map((item) => [
      item.id,
      {
        menuItemId: item.id,
        name: item.name,
        variants: item.variants
          .filter((variant) => !variant.archivedAt && variant.isAvailable)
          .map((variant) => ({ id: variant.id, name: variant.name, priceMinor: variant.priceMinor })),
        groups: item.modifierGroups.map((group) => ({
          id: group.id,
          name: group.name,
          minSelect: group.minSelect,
          maxSelect: group.maxSelect,
          modifiers: group.modifiers
            .filter((modifier) => !modifier.archivedAt && modifier.isAvailable)
            .map((modifier) => ({ id: modifier.id, name: modifier.name, priceMinor: modifier.priceMinor })),
        })),
      } satisfies ItemRequirements,
    ]),
  );
}

/** Ask the next outstanding question, or move on when there is none. */
export async function askNextOrReview(context: BotContext, lines: PendingLine[]): Promise<void> {
  const requirements = await loadRequirements(lines.map((line) => line.menuItemId));
  const question = nextQuestion(lines, requirements);

  if (!question) {
    updateSession({ intent: 'cart_review', step: null, metadata: { lines, asking: undefined } });
    await showCartForReview(context, lines);
    return;
  }

  await ask(context, question, lines);
}

async function ask(context: BotContext, question: Question, lines: PendingLine[]): Promise<void> {
  const currency = context.branch.currency;

  if (question.kind === 'variant') {
    updateSession({
      intent: 'configure_item',
      step: 'variant',
      metadata: { lines, asking: { kind: 'variant', lineIndex: question.lineIndex } },
    });

    await replyInteractive(
      context,
      listMessage({
        phoneE164: context.phoneE164,
        body: `Which size of *${question.item.name}*?`,
        label: 'Choose a size',
        sections: [
          {
            title: question.item.name,
            rows: question.item.variants.map((variant) => ({
              id: variant.id,
              title: variant.name,
              description: formatMinor(variant.priceMinor, currency),
            })),
          },
        ],
      }),
      `Which size of ${question.item.name}?`,
    );
    return;
  }

  updateSession({
    intent: 'configure_item',
    step: 'group',
    metadata: {
      lines,
      asking: { kind: 'group', lineIndex: question.lineIndex, groupId: question.group.id },
    },
  });

  await replyInteractive(
    context,
    listMessage({
      phoneE164: context.phoneE164,
      body: `*${question.item.name}* — ${question.group.name}`,
      label: 'Choose',
      sections: [
        {
          title: question.group.name,
          rows: question.group.modifiers.map((modifier) => ({
            id: modifier.id,
            title: modifier.name,
            description: modifier.priceMinor === 0 ? 'No extra charge' : `+${formatMinor(modifier.priceMinor, currency)}`,
          })),
        },
      ],
    }),
    `${question.item.name} — ${question.group.name}`,
  );
}

/** A reply to the question we last asked. */
export async function handleConfigureReply(context: BotContext, data: SessionData): Promise<void> {
  const lines = data.lines ?? [];
  const requirements = await loadRequirements(lines.map((line) => line.menuItemId));
  const question = nextQuestion(lines, requirements);

  if (!question) {
    await askNextOrReview(context, lines);
    return;
  }

  // Re-ask rather than guess. Passing the current lines back is not optional:
  // `ask` writes them to the session, so asking with an empty array would
  // silently empty the customer's cart.
  if (!context.selection) {
    await ask(context, question, lines);
    return;
  }

  // The selection must belong to the question actually asked — a stale tap on
  // an older list would otherwise write a modifier into the wrong group.
  const valid =
    question.kind === 'variant'
      ? question.item.variants.some((variant) => variant.id === context.selection)
      : question.group.modifiers.some((modifier) => modifier.id === context.selection);

  if (!valid) {
    await ask(context, question, lines);
    return;
  }

  await askNextOrReview(context, applyAnswer(lines, question, context.selection));
}

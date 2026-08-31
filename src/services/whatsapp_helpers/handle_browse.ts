import { formatMinor } from '@/lib/money';
import { listMessage } from '@/lib/whapi_templates';
import { repositories as repos } from '@/repositories';
import { updateSession } from '@/services/bot_session_service';
import { fromPriceOf } from '@/services/whatsapp_helpers/pricing_display';
import { mergeLines, type PendingLine } from '@/services/whatsapp_helpers/cart_state';
import { reply, replyInteractive, type BotContext, type SessionData } from '@/services/whatsapp_helpers/context';
import { askNextOrReview } from '@/services/whatsapp_helpers/handle_configure';

/**
 * The browse fallback (IMPLEMENTATION.md §0.1, secondary path).
 *
 * For customers who message without using the catalog, and for carts that
 * resolved to nothing. Deliberately smaller than byn2_v2's browse flow: it
 * exists so nobody is ever stuck, not to reproduce the catalog in a list.
 */

const CATEGORY_PREFIX = 'cat_';
const ITEM_PREFIX = 'itm_';

export async function startBrowse(context: BotContext): Promise<void> {
  const categories = await repos.menuItems.findPublicMenu(context.branch.id);
  const withItems = categories.filter((category) => category.items.length > 0);

  if (withItems.length === 0) {
    await reply(context, 'Nothing is on the menu just now. Please try again shortly.');
    return;
  }

  updateSession({ intent: 'browse', step: 'category' });

  await replyInteractive(
    context,
    listMessage({
      phoneE164: context.phoneE164,
      body: 'What are you in the mood for?',
      label: 'Browse the menu',
      sections: [
        {
          title: 'Categories',
          rows: withItems.map((category) => ({
            id: `${CATEGORY_PREFIX}${category.id}`,
            title: category.name,
            description: `${category.items.length} ${category.items.length === 1 ? 'dish' : 'dishes'}`,
          })),
        },
      ],
    }),
    'Browse the menu',
  );
}

export async function handleBrowseReply(context: BotContext, data: SessionData): Promise<void> {
  const selection = context.selection;

  if (!selection) {
    await startBrowse(context);
    return;
  }

  if (selection.startsWith(CATEGORY_PREFIX)) {
    await showCategory(context, selection.slice(CATEGORY_PREFIX.length));
    return;
  }

  if (selection.startsWith(ITEM_PREFIX)) {
    await addItem(context, data, selection.slice(ITEM_PREFIX.length));
    return;
  }

  await startBrowse(context);
}

async function showCategory(context: BotContext, categoryId: string): Promise<void> {
  const categories = await repos.menuItems.findPublicMenu(context.branch.id);
  const category = categories.find((candidate) => candidate.id === categoryId);

  if (!category || category.items.length === 0) {
    await startBrowse(context);
    return;
  }

  updateSession({ intent: 'browse', step: 'item', metadata: { browseCategoryId: categoryId } });

  await replyInteractive(
    context,
    listMessage({
      phoneE164: context.phoneE164,
      body: `*${category.name}*`,
      label: 'Choose a dish',
      // WhatsApp caps a list at ten rows; the template truncates, and the
      // customer can send a catalog cart for anything past that.
      sections: [
        {
          title: category.name,
          rows: category.items.map((item) => ({
            id: `${ITEM_PREFIX}${item.id}`,
            title: item.name,
            description: formatMinor(fromPriceOf(item), context.branch.currency),
          })),
        },
      ],
    }),
    category.name,
  );
}

async function addItem(context: BotContext, data: SessionData, menuItemId: string): Promise<void> {
  const item = await repos.menuItems.findById(menuItemId);
  if (!item || !item.isAvailable || item.archivedAt) {
    await reply(context, 'That one has just gone. Type *menu* to see what else we have.');
    await startBrowse(context);
    return;
  }

  const incoming: PendingLine[] = [{ menuItemId, quantity: 1, modifierIds: [] }];
  const lines = mergeLines(data.lines ?? [], incoming);

  updateSession({ intent: 'configure_item', metadata: { lines, browseCategoryId: undefined } });
  await askNextOrReview(context, lines);
}

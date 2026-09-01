import { logger } from '@/lib/logger';
import { getOrderItems } from '@/lib/whapi';
import { buttonMessage, cartSummary, droppedLinesNotice } from '@/lib/whapi_templates';
import { withoutPreview } from '@/lib/whatsapp_utils';
import { repositories as repos } from '@/repositories';
import { updateSession } from '@/services/bot_session_service';
import { priceCart } from '@/services/pricing_service';
import { mergeLines, toCartLines, type PendingLine } from '@/services/whatsapp_helpers/cart_state';
import { reply, replyInteractive, type BotContext, type SessionData } from '@/services/whatsapp_helpers/context';
import { askNextOrReview } from '@/services/whatsapp_helpers/handle_configure';

/**
 * Cart ingestion — the primary path (IMPLEMENTATION.md §0.1, §7.3).
 *
 * The customer builds a cart in WhatsApp's own catalog UI and sends it. We map
 * the lines back to menu items, drop anything that has left the menu (telling
 * them which, by name), and then re-price everything from the database.
 *
 * The cart's own `total_price` is display data and is never the charge. A
 * catalog price goes stale the moment a manager edits the menu; the database
 * does not.
 */
export async function handleCart(context: BotContext, data: SessionData): Promise<void> {
  const order = context.message.order;
  if (!order?.order_id || !order.token) {
    await reply(context, 'I could not read that cart. Type *menu* and I will help you order.');
    return;
  }

  // The base64 preview must never reach the logs.
  logger.info({ cart: withoutPreview(order) }, 'Received a WhatsApp catalog cart');

  const details = await getOrderItems(order.order_id, order.token);
  if (!details.ok) {
    logger.warn({ error: details.error }, 'Could not fetch catalog cart items');
    await reply(
      context,
      'I could not open that cart just now. Type *menu* and I will take your order here instead.',
    );
    return;
  }

  const items = details.data.items ?? [];
  const retailerIds = items
    .map((item) => item.product_retailer_id)
    .filter((id): id is string => Boolean(id));

  if (retailerIds.length === 0) {
    await reply(context, 'That cart looked empty. Type *menu* to browse what we have.');
    return;
  }

  const menuItems = await repos.menuItems.findByCatalogIds(retailerIds);

  // Indexed under every id the catalog might use to name this item.
  const byCatalogId = new Map<string, (typeof menuItems)[number]>();
  for (const item of menuItems) {
    byCatalogId.set(item.id, item);
    if (item.productRetailerId) byCatalogId.set(item.productRetailerId, item);
    if (item.whapiProductId) byCatalogId.set(item.whapiProductId, item);
  }

  const resolved: PendingLine[] = [];
  const dropped: string[] = [];

  for (const item of items) {
    const menuItem = item.product_retailer_id ? byCatalogId.get(item.product_retailer_id) : undefined;

    // Unmappable and unavailable are the same story to the customer: it is not
    // coming. They are told by name either way.
    //
    // They are emphatically NOT the same story to us. "Sold out" is the system
    // working; "the catalog sent an id we have never seen" means the catalog
    // and the database have drifted — a product created before a reseed, or
    // one Meta has not approved yet, so WhatsApp sends the line without a
    // retailer id. Both look identical in the chat, so the log is the only
    // place the difference can live. The retailer id is our own menu item id,
    // not customer data; the phone number and the cart preview stay out.
    if (!menuItem) {
      logger.warn(
        { retailerId: item.product_retailer_id ?? null, name: item.name ?? null },
        'Cart line did not map to a menu item',
      );
      dropped.push(item.name ?? 'An item');
      continue;
    }

    if (!menuItem.isAvailable || menuItem.archivedAt) {
      dropped.push(menuItem.name);
      continue;
    }

    resolved.push({
      menuItemId: menuItem.id,
      quantity: Math.min(99, Math.max(1, Math.round(item.quantity ?? 1))),
      modifierIds: [],
    });
  }

  if (dropped.length > 0) await reply(context, droppedLinesNotice(dropped));

  // Nothing survived: fall through to browsing rather than leaving them stuck.
  if (resolved.length === 0) {
    const { startBrowse } = await import('@/services/whatsapp_helpers/handle_browse');
    await startBrowse(context);
    return;
  }

  const lines = mergeLines(data.lines ?? [], resolved);
  updateSession({ intent: 'configure_item', metadata: { lines } });

  await askNextOrReview(context, lines);
}

/**
 * Show the priced cart and ask for confirmation.
 *
 * Pricing happens here rather than at ingestion because the cart only becomes
 * priceable once every required choice is answered.
 */
export async function showCartForReview(
  context: BotContext,
  lines: PendingLine[],
  origin: 'catalog' | 'conversation' = 'catalog',
): Promise<void> {
  try {
    const priced = await priceCart(context.branch.id, toCartLines(lines));

    await reply(
      context,
      cartSummary(
        priced.lines.map((line) => ({
          name: line.variantNameSnapshot
            ? `${line.itemNameSnapshot} (${line.variantNameSnapshot})`
            : line.itemNameSnapshot,
          quantity: line.quantity,
          lineTotalMinor: line.lineTotalMinor,
        })),
        priced.subtotalMinor,
        context.branch.currency,
      ),
    );

    updateSession({ intent: 'cart_review', step: null, metadata: { lines, cartOrigin: origin } });

    await replyInteractive(
      context,
      buttonMessage({
        phoneE164: context.phoneE164,
        body: 'Shall we go ahead?',
        buttons: [
          { id: 'cart_confirm', title: 'Confirm' },
          ...(origin === 'conversation' ? [{ id: 'cart_add_more', title: 'Add more' }] : []),
          { id: 'cart_cancel', title: 'Start over' },
        ],
      }),
      'Confirm the order?',
    );
  } catch (error) {
    // priceCart is the authority and it has refused. Say so plainly rather
    // than pretending the order can proceed.
    logger.warn({ err: error }, 'Could not price a WhatsApp cart');
    await reply(
      context,
      'Something in your order is no longer available. Type *menu* and we will build it again.',
    );
    updateSession({ intent: 'start', step: null, metadata: { lines: [], cartOrigin: undefined } });
  }
}

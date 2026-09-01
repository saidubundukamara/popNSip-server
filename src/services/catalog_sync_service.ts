import type { MenuItemModel } from '@/generated/prisma/models';
import { logger } from '@/lib/logger';
import { toMajor } from '@/lib/money';
import { createProduct, isWhapiConfigured, updateProduct } from '@/lib/whapi';
import type { WhapiProductInput } from '@/lib/whapi_types';
import { repositories as repos } from '@/repositories';

/**
 * Pushing the menu into the WhatsApp catalog.
 *
 * Two boundary rules, both easy to get wrong:
 *
 *   * Whapi takes `price` as a DECIMAL in major units, while everything in
 *     popNsip is integer minor units. The conversion happens here and nowhere
 *     else.
 *   * An item leaving the menu is marked `out of stock`, never deleted. That
 *     keeps the product id stable, is reversible, and — usefully — avoids the
 *     DELETE endpoint, which is inferred rather than documented.
 */

/** Sync is best-effort by design: a menu edit must never fail on a slow Whapi. */
export type SyncOutcome = { itemId: string; ok: boolean; productId?: string; error?: string };

/**
 * Whapi validates `currency` against a fixed list that has SLL but not SLE.
 * Sierra Leone redenominated in 2022 and 1 SLE is 1000 SLL, so sending the SLE
 * code is rejected outright and sending the SLE *amount* under the SLL label
 * would understate every price by a factor of a thousand.
 *
 * The amount is therefore converted along with the code. Le 50 goes out as
 * 50000 SLL, which is the same money written the old way.
 *
 * This is display only — `pricing_service` is still the sole authority on what
 * anyone is charged, and an inbound cart is always re-priced from the database
 * (FR-WA). But a catalog that misquotes a price starts arguments at the
 * counter, so it has to be right.
 *
 * Remove this the day Whapi accepts SLE.
 */
const WHAPI_CURRENCY: Record<string, { code: string; multiplier: number }> = {
  SLE: { code: 'SLL', multiplier: 1000 },
};

function toProduct(item: MenuItemModel, currency: string): WhapiProductInput {
  const mapped = WHAPI_CURRENCY[currency];

  return {
    name: item.name,
    // The one place minor units become a decimal.
    price: toMajor(item.basePriceMinor) * (mapped?.multiplier ?? 1),
    currency: mapped?.code ?? currency,
    // Whapi rejects a product with no description, so the name stands in.
    // Half the menu — sides and drinks — carries no description of its own.
    description: item.description ?? item.name,
    ...(item.imageUrl ? { images: [item.imageUrl] } : {}),
    // Our own stable id. An inbound cart line resolves back through this.
    product_retailer_id: item.id,
    availability: item.isAvailable && !item.archivedAt ? 'in stock' : 'out of stock',
  };
}

/**
 * Create or update one product.
 *
 * ⚠️ The update path is unverified. IMPLEMENTATION.md §4.1 records
 * `PATCH /business/products/{id}` as inferred; only the POST is documented. If
 * the PATCH is rejected the item is re-created through the documented POST,
 * so a wrong guess degrades to a duplicate rather than a menu that silently
 * stops syncing. Confirm the real path before trusting the fast route.
 */
export async function syncItem(item: MenuItemModel, currency = 'SLE'): Promise<SyncOutcome> {
  if (!isWhapiConfigured()) return { itemId: item.id, ok: false, error: 'WHAPI_TOKEN is not configured' };

  const product = toProduct(item, currency);

  if (item.whapiProductId) {
    const updated = await updateProduct(item.whapiProductId, product);
    if (updated.ok) return { itemId: item.id, ok: true, productId: item.whapiProductId };

    // 404/405 is the signal that the inferred path is wrong. Anything else is
    // a transient failure and should not spawn a duplicate product.
    const pathUnsupported = updated.status === 404 || updated.status === 405;
    if (!pathUnsupported) {
      return { itemId: item.id, ok: false, error: updated.error };
    }

    logger.warn(
      { itemId: item.id, status: updated.status },
      'Whapi product update path was rejected; falling back to create. Confirm PATCH /business/products/{id}.',
    );
  }

  const created = await createProduct(product);
  if (!created.ok) return { itemId: item.id, ok: false, error: created.error };

  const productId = created.data.id;
  if (productId) {
    await repos.menuItems.update(item.id, { whapiProductId: productId, productRetailerId: item.id });
  } else {
    // Without an id we cannot address the product again; the retailer id is
    // still ours and still resolves an inbound cart line.
    await repos.menuItems.update(item.id, { productRetailerId: item.id });
    logger.warn({ itemId: item.id }, 'Whapi created a product but returned no id');
  }

  return { itemId: item.id, ok: true, ...(productId ? { productId } : {}) };
}

/**
 * Queue a sync for later.
 *
 * A menu edit returns as soon as the database is written; the catalog catches
 * up on its own. Blocking a manager's save on a third party's latency is how
 * the menu screen becomes something staff avoid using.
 */
export function queueItemSync(itemId: string, currency = 'SLE'): void {
  setImmediate(() => {
    void (async () => {
      const item = await repos.menuItems.findById(itemId);
      if (!item) return;

      const outcome = await syncItem(item, currency);
      if (!outcome.ok) {
        logger.warn({ itemId, error: outcome.error }, 'Catalog sync failed; the menu is unaffected');
      }
    })();
  });
}

/** The initial push, and the repair when the catalog has drifted. */
export async function syncAll(branchId: string, currency = 'SLE'): Promise<SyncOutcome[]> {
  const items = await repos.menuItems.findSyncable(branchId);
  const outcomes: SyncOutcome[] = [];

  // Sequential on purpose: a burst of parallel writes to a third-party
  // catalog is the fastest way to find their rate limit.
  for (const item of items) {
    outcomes.push(await syncItem(item, currency));
  }

  const failed = outcomes.filter((outcome) => !outcome.ok).length;
  logger.info({ branchId, total: outcomes.length, failed }, 'Catalog sync finished');
  return outcomes;
}

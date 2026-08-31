/**
 * The price to show for an item before any choice is made.
 *
 * With variants the base price is a placeholder — the cheapest variant is what
 * the customer can actually pay, so that is what gets shown.
 */
export function fromPriceOf(item: {
  basePriceMinor: number;
  variants: { priceMinor: number }[];
}): number {
  if (item.variants.length === 0) return item.basePriceMinor;
  return Math.min(...item.variants.map((variant) => variant.priceMinor));
}

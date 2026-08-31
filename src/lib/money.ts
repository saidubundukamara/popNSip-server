/**
 * Money is an integer count of minor units (cents of a leone). Every amount in
 * the database, on the wire, and in these helpers is that integer.
 *
 * The point of this module is that no other file performs money arithmetic or
 * conversion. Floats never touch a total: `0.1 + 0.2` is the canonical
 * example, and an order total is exactly where you cannot afford it.
 */

import { InternalError } from '@/lib/errors';

export const CURRENCY = 'SLE';

/** Guard rather than trust: a non-integer here means a bug upstream. */
function assertMinor(value: number, label = 'amount'): number {
  if (!Number.isInteger(value)) {
    throw new InternalError(`Money must be an integer of minor units; received ${label}=${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new InternalError(`Money amount is outside the safe integer range; received ${label}=${value}`);
  }
  return value;
}

export const sumMinor = (...amounts: number[]): number =>
  amounts.reduce<number>((total, amount) => total + assertMinor(amount), 0);

export function multiplyMinor(amountMinor: number, quantity: number): number {
  assertMinor(amountMinor);
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new InternalError(`Quantity must be a non-negative integer; received ${quantity}`);
  }
  return assertMinor(amountMinor * quantity, 'product');
}

/**
 * Major units to minor. Rounding happens here and only here — this is the one
 * boundary where a decimal legitimately exists, and `Math.round` on the scaled
 * value is what keeps 58.07 from becoming 5806.
 */
export function toMinor(major: number): number {
  if (!Number.isFinite(major)) {
    throw new InternalError(`Cannot convert a non-finite amount; received ${major}`);
  }
  return Math.round(major * 100);
}

/** Minor units to major. For display and for external APIs that want decimals. */
export function toMajor(minor: number): number {
  return assertMinor(minor) / 100;
}

/** The one place an amount becomes a string. */
export function formatMinor(minor: number, currency: string = CURRENCY): string {
  assertMinor(minor);
  const symbol = currency === 'SLE' ? 'Le' : currency;
  const hasFraction = minor % 100 !== 0;

  return `${symbol} ${(minor / 100).toLocaleString('en-GB', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

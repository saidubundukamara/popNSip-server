import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatMinor, multiplyMinor, sumMinor, toMajor, toMinor } from '@/lib/money';

describe('money', () => {
  it('sums minor units exactly', () => {
    assert.equal(sumMinor(1000, 2000, 550), 3550);
    assert.equal(sumMinor(), 0);
  });

  it('does not accumulate float error the way major units would', () => {
    // 0.1 + 0.2 !== 0.3 in floating point; in minor units it is exact.
    assert.equal(sumMinor(10, 20), 30);
    assert.notEqual(0.1 + 0.2, 0.3);
  });

  it('rejects a non-integer amount rather than silently rounding', () => {
    assert.throws(() => sumMinor(10.5), /integer of minor units/);
    assert.throws(() => multiplyMinor(10.5, 2), /integer of minor units/);
  });

  it('multiplies by quantity', () => {
    assert.equal(multiplyMinor(5800, 3), 17400);
    assert.equal(multiplyMinor(5800, 0), 0);
  });

  it('rejects a negative or fractional quantity', () => {
    assert.throws(() => multiplyMinor(100, -1), /non-negative integer/);
    assert.throws(() => multiplyMinor(100, 1.5), /non-negative integer/);
  });

  it('rounds at the major-to-minor boundary', () => {
    assert.equal(toMinor(58), 5800);
    assert.equal(toMinor(0.1), 10);
    assert.equal(toMinor(0), 0);

    // 58.07 * 100 is 5806.999999999999 in binary floating point; rounding is
    // what recovers the intended value.
    assert.equal(toMinor(58.07), 5807);

    // Ties round up: 58.075 scales to 5807.500000000001, so 5808.
    assert.equal(toMinor(58.075), 5808);
  });

  it('is documented at the sub-cent inputs float cannot represent', () => {
    // 1.005 scales to 100.49999999999999, so it rounds DOWN to 100 — not the
    // 101 a decimal reading would give. Prices are entered to two decimals
    // (the input has step="0.01"), so this is a documented edge rather than a
    // path anything relies on.
    assert.equal(toMinor(1.005), 100);
  });

  it('round-trips a whole number of leones', () => {
    for (const major of [0, 1, 58, 12345]) {
      assert.equal(toMajor(toMinor(major)), major);
    }
  });

  it('formats with decimals only when there are any', () => {
    assert.equal(formatMinor(5800), 'Le 58');
    assert.equal(formatMinor(5850), 'Le 58.50');
    assert.equal(formatMinor(0), 'Le 0');
    assert.equal(formatMinor(123456), 'Le 1,234.56');
  });
});

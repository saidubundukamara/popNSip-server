import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ValidationError } from '@/lib/errors';
import { addDays, localToday, resolveRange } from '@/services/analytics_service';

/**
 * Range arithmetic decides which orders a figure counts, so an off-by-one here
 * is an owner reading yesterday's revenue as today's.
 */

const TZ = 'Africa/Freetown';

describe('analytics ranges', () => {
  it('reads today where the restaurant is, not where the server is', () => {
    // 00:30 UTC on the 1st. Freetown is UTC+0 year round, so it is still the
    // 1st there — but the point is that the timezone is consulted at all.
    assert.equal(localToday(TZ, new Date('2026-09-01T00:30:00Z')), '2026-09-01');

    // The same instant is already the 1st in Nairobi (UTC+3) and still the
    // 31st in New York (UTC-4).
    assert.equal(localToday('Africa/Nairobi', new Date('2026-09-01T00:30:00Z')), '2026-09-01');
    assert.equal(localToday('America/New_York', new Date('2026-09-01T00:30:00Z')), '2026-08-31');
  });

  it('adds days across a month and a year boundary', () => {
    assert.equal(addDays('2026-08-31', 1), '2026-09-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2028-03-01', -1), '2028-02-29', 'leap year');
  });

  it('makes "today" a single day, ending exclusively', () => {
    const range = resolveRange({ period: 'today', timezone: TZ, now: new Date('2026-08-31T15:00:00Z') });
    assert.equal(range.fromLocalDate, '2026-08-31');
    // Exclusive end, so the whole of the 31st counts and none of the 1st does.
    assert.equal(range.toLocalDateExclusive, '2026-09-01');
  });

  it('counts 7d and 30d inclusive of today', () => {
    const now = new Date('2026-08-31T15:00:00Z');

    const week = resolveRange({ period: '7d', timezone: TZ, now });
    assert.equal(week.fromLocalDate, '2026-08-25', 'seven days including today');
    assert.equal(week.toLocalDateExclusive, '2026-09-01');

    const month = resolveRange({ period: '30d', timezone: TZ, now });
    assert.equal(month.fromLocalDate, '2026-08-02');
    assert.equal(month.toLocalDateExclusive, '2026-09-01');
  });

  it('includes the last day of a custom range in full', () => {
    const range = resolveRange({ period: 'custom', timezone: TZ, from: '2026-08-01', to: '2026-08-31' });
    assert.equal(range.fromLocalDate, '2026-08-01');
    assert.equal(range.toLocalDateExclusive, '2026-09-01', 'the 31st must be counted, not clipped');
  });

  it('accepts a single-day custom range', () => {
    const range = resolveRange({ period: 'custom', timezone: TZ, from: '2026-08-15', to: '2026-08-15' });
    assert.equal(range.fromLocalDate, '2026-08-15');
    assert.equal(range.toLocalDateExclusive, '2026-08-16');
  });

  it('refuses a malformed or backwards custom range', () => {
    const base = { period: 'custom' as const, timezone: TZ };
    assert.throws(() => resolveRange({ ...base, from: '2026-08-01' }), ValidationError, 'missing end');
    assert.throws(() => resolveRange({ ...base, from: '01/08/2026', to: '2026-08-31' }), ValidationError);
    assert.throws(() => resolveRange({ ...base, from: '2026-08-31', to: '2026-08-01' }), ValidationError);
  });
});

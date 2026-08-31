import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  parseSignatureHeader,
  resolveOwnerId,
  sumFees,
  unwrapResult,
  verifyWebhookSignature,
} from '@/lib/monime';

/**
 * The Monime integration cannot be exercised end to end without credentials,
 * so the parts that can be tested without a network are tested hard: the
 * signature check that decides whether a body is trusted at all, and the
 * payload readers whose shape assumptions are the usual source of quiet
 * money bugs.
 */

const SECRET = 'test-webhook-secret-not-a-real-one';

const sign = (body: string, timestamp: number, secret = SECRET): string => {
  const v1 = createHmac('sha256', secret).update(`${timestamp}_${body}`, 'utf8').digest('base64');
  return `t=${timestamp},v1=${v1}`;
};

describe('monime signature header', () => {
  it('parses the documented format', () => {
    assert.deepEqual(parseSignatureHeader('t=1784112516,v1=abc123'), {
      timestamp: '1784112516',
      v1: 'abc123',
    });
  });

  it('tolerates spacing and extra pairs', () => {
    assert.deepEqual(parseSignatureHeader('t=1, v1=xyz, v2=ignored'), { timestamp: '1', v1: 'xyz' });
  });

  it('keeps base64 padding, which contains "="', () => {
    // Splitting on every '=' would truncate the signature and every
    // verification would fail for a reason nobody could see.
    assert.deepEqual(parseSignatureHeader('t=1,v1=YWJjZA=='), { timestamp: '1', v1: 'YWJjZA==' });
  });

  it('rejects a header missing either half', () => {
    assert.equal(parseSignatureHeader('t=1'), null);
    assert.equal(parseSignatureHeader('v1=abc'), null);
    assert.equal(parseSignatureHeader(''), null);
  });
});

describe('monime webhook verification', () => {
  const body = '{"event":{"id":"wkd-1","name":"payment_code.completed"}}';
  const now = new Date('2026-08-31T12:00:00Z');
  const nowSeconds = Math.floor(now.getTime() / 1000);

  it('reports not_configured rather than passing when no secret is set', () => {
    const verdict = verifyWebhookSignature(body, sign(body, nowSeconds), { now, secret: '' });
    assert.deepEqual(verdict, { ok: false, reason: 'not_configured' });
  });

  it('accepts a correct signature and rejects a tampered body', () => {
    const options = { now, secret: SECRET };
    assert.deepEqual(verifyWebhookSignature(body, sign(body, nowSeconds), options), { ok: true });
    assert.deepEqual(verifyWebhookSignature(`${body} `, sign(body, nowSeconds), options), {
      ok: false,
      reason: 'mismatch',
    });
  });

  it('rejects a signature made with the wrong secret', () => {
    const verdict = verifyWebhookSignature(body, sign(body, nowSeconds, 'not-the-secret'), {
      now,
      secret: SECRET,
    });
    assert.deepEqual(verdict, { ok: false, reason: 'mismatch' });
  });

  it('rejects a replayed capture and one from the future', () => {
    const options = { now, secret: SECRET };

    // Older than the 5-minute window: a captured delivery must not be replayable.
    assert.deepEqual(verifyWebhookSignature(body, sign(body, nowSeconds - 6 * 60), options), {
      ok: false,
      reason: 'stale',
    });
    // Beyond 60s of clock skew: a signature from the future means the secret
    // or the clock is wrong, and neither should be trusted.
    assert.deepEqual(verifyWebhookSignature(body, sign(body, nowSeconds + 120), options), {
      ok: false,
      reason: 'stale',
    });
    // Just inside both bounds still passes.
    assert.deepEqual(verifyWebhookSignature(body, sign(body, nowSeconds - 4 * 60), options), { ok: true });
  });

  it('rejects a malformed or non-numeric header', () => {
    const options = { now, secret: SECRET };
    assert.deepEqual(verifyWebhookSignature(body, 'garbage', options), { ok: false, reason: 'malformed' });
    assert.deepEqual(verifyWebhookSignature(body, '', options), { ok: false, reason: 'malformed' });
    assert.deepEqual(verifyWebhookSignature(body, 't=abc,v1=zzz', options), {
      ok: false,
      reason: 'bad_timestamp',
    });
  });
});

describe('monime payload readers', () => {
  it('sums a fee array rather than reading the first entry', () => {
    const fees = [
      { amount: { currency: 'SLE', value: 300 }, code: 'Base' },
      { amount: { currency: 'SLE', value: 45 }, code: 'Other' },
    ];
    assert.equal(sumFees(fees), 345);
  });

  it('distinguishes "no fee reported" from "a fee of zero"', () => {
    // Writing 0 over a real figure recorded by a sibling event is the bug this
    // guards; null says nothing was reported.
    assert.equal(sumFees(undefined), null);
    assert.equal(sumFees([]), null);
    assert.equal(sumFees([{ code: 'Base' }]), null);
    assert.equal(sumFees([{ amount: { currency: 'SLE', value: 0 }, code: 'Base' }]), 0);
  });

  it('flattens a double-nested result, which only the live API sends', () => {
    const live = { result: { status: 'completed', reference: 'ord_1' }, id: 'pmc-1' };
    const flat = unwrapResult(live as unknown as Record<string, unknown>);
    assert.equal(flat['status'], 'completed');
    assert.equal(flat['reference'], 'ord_1');
    assert.equal(flat['id'], 'pmc-1');
  });

  it('leaves an already-flat body alone', () => {
    const flat = unwrapResult({ id: 'pmc-1', status: 'pending' });
    assert.deepEqual(flat, { id: 'pmc-1', status: 'pending' });
  });

  it('reads the owner id from the ownership graph, not a flat field', () => {
    assert.equal(
      resolveOwnerId({ ownershipGraph: { owner: { type: 'payment_code', id: 'pmc-9' } } }),
      'pmc-9',
    );
    assert.equal(resolveOwnerId({}), undefined);
    assert.equal(resolveOwnerId(undefined), undefined);
  });
});

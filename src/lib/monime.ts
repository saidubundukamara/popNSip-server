import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { env } from '@/config/env';
import { UpstreamError } from '@/lib/errors';
import { logger } from '@/lib/logger';

/**
 * The Monime adapter. Every call to Monime goes through this file, so a change
 * to their API touches one place (PRD risk R3).
 *
 * Shapes here are taken from two working integrations rather than guessed:
 * byn2_v2's payment-code request, and ib4me's captured ground truth for the
 * webhook envelope, signature scheme, and response nesting.
 */

// ─── types ────────────────────────────────────────────────────────────────

export type MonimeAmount = { currency: string; value: number };

/**
 * Reported as an ARRAY of `{ amount, code }`. Sum it — never read `[0]`. The
 * set of codes is Monime's to extend, and only "Base" has been observed.
 */
export type MonimeFee = { amount?: MonimeAmount | null; code?: string; metadata?: unknown };

export type MonimePaymentCode = {
  id: string;
  status?: string;
  ussdCode?: string;
  reference?: string;
  amount?: MonimeAmount;
  expireTime?: string;
  metadata?: Record<string, unknown>;
};

/** The `data` of a settlement webhook, and of a polled payment read. */
export type MonimePaymentData = {
  id?: string;
  status?: string;
  reference?: string;
  amount?: MonimeAmount;
  fees?: MonimeFee[];
  channel?: { type?: string; provider?: string; reference?: string; phoneNumber?: string };
  financialAccountId?: string;
  financialTransactionReference?: string;
  ownershipGraph?: { owner?: { type?: string; id?: string } };
  metadata?: Record<string, unknown>;
};

export type MonimeWebhookPayload = {
  apiVersion?: string;
  event: { id: string; name: string; timestamp?: string };
  object?: { id: string; type?: string };
  data?: MonimePaymentData;
};

// ─── response shape helpers ───────────────────────────────────────────────

/**
 * Flatten a body that may be wrapped — or double-wrapped — in `result`.
 *
 * The live API nests `status` / `reference` / `metadata` under a second
 * `result` where a flat stub does not, so this only ever bites in production.
 * Unwrap defensively rather than discovering it with real money.
 */
export function unwrapResult<T extends Record<string, unknown>>(body: T): T {
  const inner = (body as { result?: unknown }).result;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    return { ...(inner as T), ...body };
  }
  return body;
}

/** Total fee in minor units, or null when Monime reported none. */
export function sumFees(fees: MonimeFee[] | undefined | null): number | null {
  if (!Array.isArray(fees) || fees.length === 0) return null;

  let total = 0;
  let sawValue = false;
  for (const fee of fees) {
    const value = fee?.amount?.value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      total += value;
      sawValue = true;
    }
  }
  // null, not 0: "no fee reported" and "a fee of zero" are different facts, and
  // writing 0 over a real figure recorded by a sibling event is the bug.
  return sawValue ? total : null;
}

/**
 * The payment-code or session a payment belongs to. The live payload puts it
 * at `ownershipGraph.owner`, not at a flat id.
 */
export const resolveOwnerId = (data: MonimePaymentData | undefined): string | undefined =>
  data?.ownershipGraph?.owner?.id;

// ─── the client ───────────────────────────────────────────────────────────

const isConfigured = (): boolean => Boolean(env.MONIME_TOKEN && env.MONIME_SPACE_ID);

function assertConfigured(): void {
  if (!isConfigured()) {
    throw new UpstreamError('monime', 'Mobile money is not configured on this server.', {
      missing: 'MONIME_TOKEN / MONIME_SPACE_ID',
    });
  }
}

async function request<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string },
): Promise<T> {
  assertConfigured();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.MONIME_TOKEN ?? ''}`,
    'Monime-Space-Id': env.MONIME_SPACE_ID ?? '',
    'Monime-Version': env.MONIME_VERSION,
    'Content-Type': 'application/json',
  };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${env.MONIME_BASE_URL}${path}`, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new UpstreamError('monime', 'Could not reach the payment provider.', { path }, { cause: error });
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const detail = body as { error?: { code?: string; message?: string }; message?: string } | null;
    // The path is logged, never the body: it carries customer phone numbers.
    logger.error(
      { status: response.status, path, code: detail?.error?.code },
      'Monime request failed',
    );
    throw new UpstreamError('monime', 'The payment provider rejected the request.', {
      status: response.status,
      code: detail?.error?.code,
      message: detail?.error?.message ?? detail?.message,
    });
  }

  return unwrapResult((body ?? {}) as Record<string, unknown>) as T;
}

export type CreatePaymentCodeInput = {
  /** Shown to the customer on their handset. */
  name: string;
  amountMinor: number;
  currency?: string;
  customerName: string;
  /** Echoed back on the webhook, so it must be the order id. */
  reference: string;
  /** Orange (m17) and Africell (m18). */
  authorizedProviders?: string[];
  /** Restricts the code to one handset when known. */
  authorizedPhoneNumber?: string | undefined;
  duration?: string;
  metadata?: Record<string, unknown>;
};

export async function createPaymentCode(input: CreatePaymentCodeInput): Promise<MonimePaymentCode> {
  const result = await request<MonimePaymentCode>('/payment-codes', {
    method: 'POST',
    // A fresh key per attempt: this is Monime's guard against our own retries,
    // not against a duplicate order — Order.idempotencyKey handles that.
    idempotencyKey: randomUUID(),
    body: {
      name: input.name,
      mode: 'one_time',
      enable: true,
      amount: { currency: input.currency ?? 'SLE', value: input.amountMinor },
      duration: input.duration ?? '1h30m',
      customer: { name: input.customerName },
      reference: input.reference,
      authorizedProviders: input.authorizedProviders ?? ['m17', 'm18'],
      ...(input.authorizedPhoneNumber ? { authorizedPhoneNumber: input.authorizedPhoneNumber } : {}),
      metadata: input.metadata ?? {},
    },
  });

  if (!result.id) {
    throw new UpstreamError('monime', 'The payment provider returned no payment code.');
  }
  return result;
}

/**
 * The authoritative state of a payment code. This is what reconciliation asks
 * when a webhook never arrives (FR-PAY-7).
 *
 * Note that polled reads carry no `fees[]` — anything settled this way records
 * the gross without the provider's cut.
 */
export const getPaymentCode = (id: string): Promise<MonimePaymentCode & MonimePaymentData> =>
  request(`/payment-codes/${id}`, { method: 'GET' });

export { isConfigured as isMonimeConfigured };

// ─── webhook signature ────────────────────────────────────────────────────

/** How far out of step with Monime's clock a delivery may be. */
const MAX_AGE_SECONDS = 5 * 60;
const MAX_SKEW_SECONDS = 60;

export function parseSignatureHeader(header: string): { timestamp: string; v1: string } | null {
  let timestamp: string | null = null;
  let v1: string | null = null;

  for (const part of (header || '').split(',')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === 't') timestamp = value;
    if (key === 'v1') v1 = value;
  }

  return timestamp && v1 ? { timestamp, v1 } : null;
}

export type SignatureVerdict =
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'malformed' | 'bad_timestamp' | 'stale' | 'mismatch' };

/**
 * Verify a `monime-signature: t=<unix>,v1=<base64>` header.
 *
 * Monime signs `<timestamp>_<rawBody>` with HMAC-SHA256 keyed by the webhook
 * secret and base64-encodes it. Verification runs against the RAW body, before
 * anything parses it as trusted input (FR-PAY-6).
 */
export function verifyWebhookSignature(
  rawBody: string,
  header: string,
  options: { now?: Date; secret?: string } = {},
): SignatureVerdict {
  // The secret is injectable so this can be tested without an ambient one —
  // the check that decides whether a body is trusted at all is exactly the
  // thing that should not go untested for want of configuration.
  const secret = options.secret ?? env.MONIME_WEBHOOK_SECRET;
  if (!secret) return { ok: false, reason: 'not_configured' };

  const now = options.now ?? new Date();

  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: 'malformed' };

  const timestamp = Number.parseInt(parsed.timestamp, 10);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'bad_timestamp' };

  // Replay protection: an old capture must not be replayable, and a delivery
  // from the future is a sign the secret or the clock is wrong.
  const age = Math.floor(now.getTime() / 1000) - timestamp;
  if (age > MAX_AGE_SECONDS || age < -MAX_SKEW_SECONDS) return { ok: false, reason: 'stale' };

  const expected = createHmac('sha256', secret).update(`${parsed.timestamp}_${rawBody}`, 'utf8').digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(parsed.v1, 'base64');
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false.
  if (provided.length !== expected.length) return { ok: false, reason: 'mismatch' };
  return timingSafeEqual(provided, expected) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

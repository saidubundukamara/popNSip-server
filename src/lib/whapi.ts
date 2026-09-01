import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import { toWhapiNumber } from '@/lib/phone';
import type {
  WhapiBusinessProfile,
  WhapiErrorBody,
  WhapiInteractivePayload,
  WhapiOrderDetails,
  WhapiProduct,
  WhapiProductInput,
} from '@/lib/whapi_types';

/**
 * The Whapi.cloud client.
 *
 * Two deliberate departures from byn2_v2's version, which this is otherwise
 * lifted from:
 *
 *   * calls return a typed result rather than a bare boolean, so a caller can
 *     tell "the message was rejected" from "we could not reach Whapi" and
 *     decide whether retrying is worth anything;
 *   * the '+' comes off a phone number in exactly one place — `recipient()` —
 *     rather than at every call site, which is how one forgotten
 *     `.replace('+','')` sends a message into the void.
 */

export type WhapiResult<T> = { ok: true; data: T } | { ok: false; status?: number; error: string };

export const isWhapiConfigured = (): boolean => Boolean(env.WHAPI_TOKEN);

/**
 * The single boundary where a stored E.164 number becomes what Whapi wants.
 * Every send goes through this.
 */
const recipient = (phoneE164: string): string => toWhapiNumber(phoneE164);

async function call<T>(
  path: string,
  init: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; query?: Record<string, string> },
): Promise<WhapiResult<T>> {
  if (!isWhapiConfigured()) {
    return { ok: false, error: 'WHAPI_TOKEN is not configured' };
  }

  const url = new URL(`${env.WHAPI_URL}${path}`);
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);

  try {
    const response = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${env.WHAPI_TOKEN ?? ''}`,
        'Content-Type': 'application/json',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(20_000),
    });

    const data: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const failure = (data as WhapiErrorBody | null)?.error;

      // Whapi's own `message` is often a generic restatement of the status —
      // "wrong request parameters" — while the sentence that says what is
      // actually wrong sits in `details`, forwarded from Meta. Reporting only
      // the outer message turns "no catalog is attached to this WhatsApp
      // Business account" into something nobody can act on.
      const details = failure?.details;
      const detail =
        typeof details === 'string' ? details : (details?.description ?? details?.message);
      const message = failure?.message ?? `Whapi returned ${response.status}`;

      // The path and the failure are logged; the request body and query never
      // are, because both carry customer phone numbers and an order token is a
      // bearer credential. A response's error details are the provider
      // describing itself, so they are safe.
      logger.warn({ status: response.status, path, whapi: failure }, 'Whapi request failed');

      return {
        ok: false,
        status: response.status,
        error: detail ? `${message}: ${detail}` : message,
      };
    }

    return { ok: true, data: (data ?? {}) as T };
  } catch (error) {
    logger.warn({ err: error, path }, 'Could not reach Whapi');
    return { ok: false, error: error instanceof Error ? error.message : 'Network error' };
  }
}

// ─── messages ─────────────────────────────────────────────────────────────

export const sendText = (phoneE164: string, body: string, typingTime = 2) =>
  call<{ sent?: boolean; message?: { id?: string } }>('/messages/text', {
    method: 'POST',
    body: { to: recipient(phoneE164), body, typing_time: typingTime },
  });

export const sendImage = (phoneE164: string, media: string, caption?: string) =>
  call<{ sent?: boolean; message?: { id?: string } }>('/messages/image', {
    method: 'POST',
    body: { to: recipient(phoneE164), media, caption: caption ?? '', typing_time: 2 },
  });

/**
 * Lists and buttons. The payload already carries `to`, because the template
 * builders need the recipient to construct it.
 */
export const sendInteractive = (payload: WhapiInteractivePayload) =>
  call<{ sent?: boolean; message?: { id?: string } }>('/messages/interactive', {
    method: 'POST',
    body: payload,
  });

/** Good for the "finish on the web" handoff. */
export const sendLinkPreview = (phoneE164: string, body: string, title: string, media?: string) =>
  call<{ sent?: boolean }>('/messages/link_preview', {
    method: 'POST',
    body: { to: recipient(phoneE164), body, title, ...(media ? { media } : {}) },
  });

// ─── catalog ──────────────────────────────────────────────────────────────

export const createProduct = (product: WhapiProductInput) =>
  call<WhapiProduct>('/business/products', { method: 'POST', body: product });

/**
 * ⚠️ UNVERIFIED PATH. IMPLEMENTATION.md §4.1 lists `PATCH /business/products/{id}`
 * as inferred, not documented, and it has never been run against the live API.
 *
 * Callers must treat a 404/405 from here as "updating is unsupported" and fall
 * back to `createProduct`, which is documented — see catalog_sync_service.
 */
export const updateProduct = (productId: string, product: Partial<WhapiProductInput>) =>
  call<WhapiProduct>(`/business/products/${productId}`, { method: 'PATCH', body: product });

/**
 * ⚠️ UNVERIFIED PATH, same caveat as updateProduct.
 *
 * Nothing in popNsip calls this: an item leaving the menu is marked
 * `out of stock` instead, which is documented, reversible, and keeps the
 * product id stable so a returning item does not need re-syncing.
 */
export const deleteProduct = (productId: string) =>
  call<unknown>(`/business/products/${productId}`, { method: 'DELETE' });

/**
 * The lines of a catalog cart.
 *
 * Both tokens go in the QUERY STRING, not headers — this is the one call whose
 * shape is easy to get wrong, and it fails opaquely when you do.
 */
export const getOrderItems = (orderId: string, orderToken: string) =>
  call<WhapiOrderDetails>(`/business/orders/${orderId}`, {
    method: 'GET',
    query: { order_token: orderToken, token: env.WHAPI_TOKEN ?? '' },
  });

export const getBusinessProfile = () => call<WhapiBusinessProfile>('/business', { method: 'GET' });

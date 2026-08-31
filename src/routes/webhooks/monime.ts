import { Router, raw } from 'express';
import type { Response } from 'express';

import { logger } from '@/lib/logger';
import { verifyWebhookSignature, type MonimeWebhookPayload } from '@/lib/monime';
import { repositories as repos } from '@/repositories';
import { handleMonimeEvent } from '@/services/monime_service';

/**
 * The Monime webhook.
 *
 * Mounted in app.ts BEFORE express.json(), because the signature is computed
 * over the exact bytes Monime sent — a re-serialised body will not match.
 */
export const monimeWebhookRouter: Router = Router();

monimeWebhookRouter.post(
  '/api/webhooks/monime',
  raw({ type: '*/*', limit: '1mb' }),
  (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const signature = req.get('monime-signature') ?? '';

    // ── verify first, parse second (FR-PAY-6) ──
    const verdict = verifyWebhookSignature(rawBody, signature);
    if (!verdict.ok) {
      logger.warn({ reason: verdict.reason, ip: req.ip }, 'Rejected a Monime webhook');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    let payload: MonimeWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as MonimeWebhookPayload;
    } catch {
      // 400, not 500: a body we cannot parse will not parse on retry either.
      res.status(400).json({ error: 'Malformed payload' });
      return;
    }

    const eventId = payload?.event?.id;
    const eventName = payload?.event?.name;
    if (!eventId || !eventName) {
      res.status(400).json({ error: 'Missing event id or name' });
      return;
    }

    void process(req.id, eventId, eventName, payload, res);
  },
);

async function process(
  requestId: string,
  eventId: string,
  eventName: string,
  payload: MonimeWebhookPayload,
  res: Response,
): Promise<void> {
  try {
    // ── claim the delivery (FR-PAY-5) ──
    // The unique constraint decides. A replay finds the row already there and
    // is acknowledged without re-applying its effect.
    const claimed = await repos.webhookEvents.claim({
      provider: 'monime',
      providerEventId: eventId,
      eventName,
      payload: payload as unknown as object,
    });

    if (!claimed) {
      logger.info({ eventId, eventName }, 'Replayed Monime event, already processed');
      res.status(200).json({ received: true, replayed: true });
      return;
    }

    try {
      const outcome = await handleMonimeEvent(payload);
      await repos.webhookEvents.markProcessed(
        claimed.id,
        outcome.handled ? undefined : outcome.reason,
      );

      // Understood but irrelevant is still a 200. A 500 makes Monime retry an
      // event we have already decided we cannot act on.
      res.status(200).json({ received: true, ...outcome });
    } catch (error) {
      // Release the claim so Monime's retry is allowed to succeed, then fail
      // loudly — a claimed-but-unprocessed event is a payment in limbo.
      await repos.webhookEvents
        .release(claimed.id, error instanceof Error ? error.message : String(error))
        .catch(() => undefined);
      throw error;
    }
  } catch (error) {
    logger.error({ err: error, requestId, eventId, eventName }, 'Monime webhook processing failed');
    // 500 so Monime retries: this is our fault, not theirs.
    res.status(500).json({ error: 'Processing failed' });
  }
}

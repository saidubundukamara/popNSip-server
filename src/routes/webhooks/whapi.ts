import { Router } from 'express';

import { logger } from '@/lib/logger';
import { sendText } from '@/lib/whapi';
import type { WhapiWebhookBody } from '@/lib/whapi_types';
import { inboundMessageOf, toE164 } from '@/lib/whatsapp_utils';
import { repositories as repos } from '@/repositories';
import { init } from '@/services/whatsapp_service';

/**
 * The Whapi webhook.
 *
 * The guard clauses mirror byn2_v2's, which are the product of a bot that ran
 * in production: answer 200 early for anything that is not a message, honour
 * the kill switch, and on failure still try to tell the customer something
 * went wrong rather than leaving them staring at a silent chat.
 *
 * Whapi does not sign its webhooks, so unlike the Monime receiver this one
 * mounts after the JSON parser and has no signature to verify. That is worth
 * knowing: the URL is the only secret, so it should be long and unguessable.
 */
export const whapiWebhookRouter: Router = Router();

whapiWebhookRouter.post('/api/webhooks/whapi', (req, res) => {
  const body = req.body as WhapiWebhookBody | undefined;

  // Status updates, delivery receipts, and our own outbound echoes all arrive
  // here. None of them is a customer saying something.
  const message = body ? inboundMessageOf(body) : null;
  if (!message?.from) {
    res.status(200).json({ received: true, message: 'nothing to process' });
    return;
  }

  // Answer before doing the work. Whapi retries a slow webhook, and a retry
  // while the first is still running is how one message gets two replies.
  res.status(200).json({ received: true });

  void handle(body as WhapiWebhookBody, toE164(message.from), req.id);
});

async function handle(body: WhapiWebhookBody, phoneE164: string, requestId: string): Promise<void> {
  try {
    const branch = await repos.branches.findFirst();

    if (branch && !branch.botEnabled) {
      await sendText(
        phoneE164,
        'Our ordering assistant is paused for maintenance right now. Please call us and we will take your order.',
      );
      return;
    }

    await init(body);
  } catch (error) {
    logger.error({ err: error, requestId }, 'WhatsApp bot failed');

    // Last resort. The customer said something and deserves an answer, even
    // when the answer is that we could not manage it.
    await sendText(
      phoneE164,
      'Sorry, something went wrong on our side. Please try again, or type *menu* to start over.',
    ).catch(() => undefined);
  }
}

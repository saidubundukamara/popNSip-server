import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { StaffRole } from '@/generated/prisma/enums';
import { BadRequestError, NotFoundError } from '@/lib/errors';
import { requireAuth, requireRole } from '@/middleware/auth';
import { repositories as repos } from '@/repositories';
import { audit } from '@/services/audit_service';
import { syncAll } from '@/services/catalog_sync_service';
import { sendNow } from '@/services/wa_notification_service';

/**
 * The staff side of WhatsApp: conversations waiting on a person, and the
 * catalog sync they can trigger by hand when it has drifted.
 */
export const staffWhatsAppRouter: Router = Router();

const handler =
  (fn: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const actorOf = (req: Parameters<RequestHandler>[0]) => {
  const user = req.user;
  if (!user) throw new BadRequestError('No session.');
  return user;
};

/** FR-WA-9: who is waiting for a human. */
staffWhatsAppRouter.get(
  '/api/staff/whatsapp/conversations',
  requireAuth,
  handler(async (_req, res) => {
    res.json({ conversations: await repos.conversations.findNeedingHuman() });
  }),
);

staffWhatsAppRouter.get(
  '/api/staff/whatsapp/conversations/:id',
  requireAuth,
  handler(async (req, res) => {
    const id = req.params.id;
    if (typeof id !== 'string') throw new NotFoundError('Conversation not found.');

    const conversation = await repos.conversations.findById(id);
    if (!conversation) throw new NotFoundError('Conversation not found.');

    const messages = await repos.waMessages.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    res.json({ conversation, messages });
  }),
);

/** Reply as the restaurant, and hand the thread back to the bot. */
staffWhatsAppRouter.post(
  '/api/staff/whatsapp/conversations/:id/reply',
  requireAuth,
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = req.params.id;
    if (typeof id !== 'string') throw new NotFoundError('Conversation not found.');

    const { body, release } = z
      .object({ body: z.string().trim().min(1).max(1000), release: z.boolean().default(false) })
      .parse(req.body);

    const conversation = await repos.conversations.findById(id);
    if (!conversation) throw new NotFoundError('Conversation not found.');

    const sent = await sendNow({
      phoneE164: conversation.phoneE164,
      body,
      kind: 'staff_reply',
      conversationId: id,
    });

    // Releasing hands the thread back to the bot; leaving it held keeps the
    // bot quiet while a person is still typing.
    if (release) await repos.conversations.update(id, { needsHuman: false, intent: 'start', step: null });

    await audit({
      actor,
      action: 'whatsapp.staff_replied',
      targetType: 'WhatsAppConversation',
      targetId: id,
      after: { released: release },
      requestId: req.id,
    });

    res.json({ sent, released: release });
  }),
);

/**
 * Push the whole menu to the WhatsApp catalog. Manager and above, because it
 * is a bulk write to a third party.
 */
staffWhatsAppRouter.post(
  '/api/staff/whatsapp/catalog/sync',
  requireRole(StaffRole.MANAGER),
  handler(async (req, res) => {
    const actor = actorOf(req);
    const branch = await repos.branches.findById(actor.branchId);
    if (!branch) throw new NotFoundError('Branch not found.');

    const outcomes = await syncAll(branch.id, branch.currency);
    const failed = outcomes.filter((outcome) => !outcome.ok);

    await audit({
      actor,
      action: 'whatsapp.catalog_synced',
      targetType: 'Branch',
      targetId: branch.id,
      after: { total: outcomes.length, failed: failed.length },
      requestId: req.id,
    });

    res.json({ total: outcomes.length, synced: outcomes.length - failed.length, failed });
  }),
);

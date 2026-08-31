import { flushQueue, type FlushResult } from '@/services/wa_notification_service';

/**
 * Drain the outbound WhatsApp queue.
 *
 * Order notifications are queued rather than sent inline so a slow send never
 * blocks a status transition (FR-WA-8); this is what eventually sends them.
 */
export const flushWaQueue = (): Promise<FlushResult> => flushQueue();

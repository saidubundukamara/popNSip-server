import { flushQueueSerialised, type FlushResult } from '@/services/wa_notification_service';

/**
 * Drain the outbound WhatsApp queue.
 *
 * Order notifications are queued rather than sent inline so a slow send never
 * blocks a status transition (FR-WA-8). Each enqueue kicks a flush of its own;
 * this sweep picks up retries that are due and anything a restart dropped.
 */
export const flushWaQueue = (): Promise<FlushResult> => flushQueueSerialised();

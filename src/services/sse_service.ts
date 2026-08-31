import type { Response } from 'express';

import { logger } from '@/lib/logger';

/**
 * Server-Sent Events, keyed by branch (IMPLEMENTATION.md §1.3).
 *
 * SSE rather than WebSocket because the dashboard's traffic is one-directional:
 * staff actions are ordinary REST calls that want a status code, and
 * EventSource reconnects on its own with Last-Event-ID rather than needing a
 * reconnect loop written, subtly mis-written, and then debugged over a bad
 * connection.
 */

export type OrderEventName = 'order.created' | 'order.updated' | 'order.status_changed';

export type OrderEvent = {
  name: OrderEventName;
  /** Kept small deliberately: the client refetches what it needs. */
  data: Record<string, unknown>;
};

type Subscriber = {
  id: number;
  response: Response;
  heartbeat: NodeJS.Timeout;
};

/** Proxies close an idle stream; a comment keeps it warm without being an event. */
const HEARTBEAT_MS = 20_000;

/**
 * Replayed to a client that reconnects with Last-Event-ID. Bounded, because an
 * unbounded buffer is a memory leak wearing a useful hat — a client that has
 * been gone longer than this refetches instead.
 */
const REPLAY_BUFFER_SIZE = 50;

const subscribers = new Map<string, Set<Subscriber>>();
const replayBuffer = new Map<string, { id: number; payload: string }[]>();

let nextSubscriberId = 1;
let lastEventId = 0;

function frame(id: number, event: OrderEvent): string {
  return `id: ${id}\nevent: ${event.name}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/**
 * Register a response as a stream. Returns the unsubscribe function; the
 * caller wires it to the request's 'close'.
 */
export function subscribe(branchId: string, response: Response, lastSeenId?: number): () => void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx buffers proxied responses by default, which holds every event
    // until the buffer fills. This is the header that stops it.
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders();

  // Tell EventSource to wait 2s before reconnecting rather than its default 3s.
  response.write('retry: 2000\n\n');

  const subscriber: Subscriber = {
    id: nextSubscriberId++,
    response,
    heartbeat: setInterval(() => {
      response.write(': ping\n\n');
    }, HEARTBEAT_MS),
  };

  const set = subscribers.get(branchId) ?? new Set<Subscriber>();
  set.add(subscriber);
  subscribers.set(branchId, set);

  // Catch the client up on anything it missed while reconnecting.
  if (lastSeenId !== undefined) {
    for (const buffered of replayBuffer.get(branchId) ?? []) {
      if (buffered.id > lastSeenId) response.write(buffered.payload);
    }
  }

  logger.debug({ branchId, subscribers: set.size }, 'SSE client subscribed');

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;

    clearInterval(subscriber.heartbeat);
    subscribers.get(branchId)?.delete(subscriber);
    if (subscribers.get(branchId)?.size === 0) subscribers.delete(branchId);
    response.end();

    logger.debug({ branchId, subscribers: subscribers.get(branchId)?.size ?? 0 }, 'SSE client unsubscribed');
  };
}

/** Fan out to a branch. Called only after a transaction commits. */
export function emit(branchId: string, event: OrderEvent): void {
  const id = ++lastEventId;
  const payload = frame(id, event);

  const buffered = replayBuffer.get(branchId) ?? [];
  buffered.push({ id, payload });
  if (buffered.length > REPLAY_BUFFER_SIZE) buffered.shift();
  replayBuffer.set(branchId, buffered);

  for (const subscriber of subscribers.get(branchId) ?? []) {
    try {
      subscriber.response.write(payload);
    } catch (error) {
      // A dead socket must not take the emit — or the request that caused
      // it — down with it.
      logger.warn({ err: error, branchId }, 'Failed to write to an SSE client');
    }
  }
}

export const connectionCount = (branchId?: string): number =>
  branchId
    ? (subscribers.get(branchId)?.size ?? 0)
    : [...subscribers.values()].reduce((total, set) => total + set.size, 0);

/** Graceful shutdown: a stream never closes on its own. */
export function closeConnections(): void {
  for (const set of subscribers.values()) {
    for (const subscriber of set) {
      clearInterval(subscriber.heartbeat);
      subscriber.response.end();
    }
  }
  subscribers.clear();
  replayBuffer.clear();
}

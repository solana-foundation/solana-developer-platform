/**
 * Redis pub/sub for notification inbox nudges (the realtime last mile behind the
 * dashboard bell's SSE stream).
 *
 * Publish side: any process (web service or the cron job) publishes a tiny
 * NotificationInboxNudge to the per-(org, user) channel after a fan-out inserts rows.
 * PUBLISH is legal on a normal connection, so it reuses the shared kv-redis client.
 *
 * Subscribe side: ONE dedicated subscriber connection per URL per process (ioredis
 * puts a connection into subscriber mode, where regular commands are refused), with an
 * in-process router (channel → listeners) and refcounted exact-channel SUBSCRIBE.
 * Never PSUBSCRIBE `notifications:inbox:*` — that would deliver every org's nudges to
 * every replica; exact channels make Redis fan out only what this replica watches.
 *
 * Delivery is best-effort by design: a dropped message costs one polling interval
 * (the bell's 60s poll is the fallback), so failures here log and continue.
 */

import { type NotificationInboxNudge, notificationInboxChannel } from "@sdp/types";
import type { Redis } from "ioredis";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import { getRedisClient } from "./kv-redis";

export type InboxNudgeListener = (nudge: NotificationInboxNudge) => void;

interface SubscriberState {
  clientPromise: Promise<Redis>;
  listenersByChannel: Map<string, Set<InboxNudgeListener>>;
}

// One subscriber state per REDIS_URL (in practice a single entry).
const subscribersByUrl = new Map<string, SubscriberState>();

function requireRedisUrl(env: Env): string {
  const url = env.REDIS_URL?.trim();
  if (!url) {
    throw new Error("REDIS_URL is required for notification pub/sub.");
  }
  return url;
}

function ensureSubscriber(url: string): SubscriberState {
  const existing = subscribersByUrl.get(url);
  if (existing) return existing;

  const listenersByChannel = new Map<string, Set<InboxNudgeListener>>();
  const clientPromise = (async (): Promise<Redis> => {
    const { default: IORedis } = await import("ioredis");
    const client = new IORedis(url, {
      lazyConnect: false,
      // Subscriber must survive Redis restarts: never fail queued SUBSCRIBEs, and let
      // ioredis auto-resubscribe its tracked channels after reconnect.
      maxRetriesPerRequest: null,
    });
    client.on("message", (channel: string, message: string) => {
      const listeners = listenersByChannel.get(channel);
      if (!listeners || listeners.size === 0) return;
      let nudge: NotificationInboxNudge;
      try {
        const parsed = JSON.parse(message) as Partial<NotificationInboxNudge>;
        if (typeof parsed.unread !== "number") return;
        nudge = { unread: parsed.unread, ts: typeof parsed.ts === "string" ? parsed.ts : "" };
      } catch {
        // Malformed publish — drop it; the polling fallback covers the gap.
        return;
      }
      for (const listener of listeners) {
        try {
          listener(nudge);
        } catch (error) {
          getLogger().error(
            { error: error instanceof Error ? error.message : String(error) },
            "notification nudge listener failed"
          );
        }
      }
    });
    // Without a handler ioredis re-emits connection errors as uncaught exceptions.
    client.on("error", (error: Error) => {
      getLogger().warn({ error: error.message }, "notification subscriber redis error");
    });
    return client;
  })();
  clientPromise.catch(() => {
    if (subscribersByUrl.get(url)?.clientPromise === clientPromise) {
      subscribersByUrl.delete(url);
    }
  });

  const state: SubscriberState = { clientPromise, listenersByChannel };
  subscribersByUrl.set(url, state);
  return state;
}

/**
 * Publish an inbox nudge for one (org, user). Best-effort: callers treat a rejected
 * promise as a log-and-continue event, never a dispatch failure.
 */
export async function publishInboxNudge(
  env: Env,
  organizationId: string,
  userId: string,
  nudge: NotificationInboxNudge
): Promise<void> {
  const client = await getRedisClient(env);
  await client.publish(notificationInboxChannel(organizationId, userId), JSON.stringify(nudge));
}

/**
 * Subscribe a listener to one (org, user) inbox channel. Returns an async unsubscribe.
 * The channel's SUBSCRIBE is issued on the first listener and UNSUBSCRIBE after the
 * last one leaves (refcounted via the listener set).
 */
export async function subscribeInbox(
  env: Env,
  organizationId: string,
  userId: string,
  listener: InboxNudgeListener
): Promise<() => Promise<void>> {
  const url = requireRedisUrl(env);
  const state = ensureSubscriber(url);
  const channel = notificationInboxChannel(organizationId, userId);

  let listeners = state.listenersByChannel.get(channel);
  const isFirstListener = !listeners || listeners.size === 0;
  if (!listeners) {
    listeners = new Set();
    state.listenersByChannel.set(channel, listeners);
  }
  listeners.add(listener);

  if (isFirstListener) {
    const client = await state.clientPromise;
    // May reject while Redis is down; ioredis re-subscribes tracked channels on
    // reconnect, and the bell's polling covers any window with no live subscription.
    await client.subscribe(channel).catch((error: Error) => {
      getLogger().error({ channel, error: error.message }, "notification subscribe failed");
    });
  }

  return async () => {
    const current = state.listenersByChannel.get(channel);
    if (!current) return;
    current.delete(listener);
    if (current.size > 0) return;
    state.listenersByChannel.delete(channel);
    try {
      const client = await state.clientPromise;
      await client.unsubscribe(channel);
    } catch (error) {
      getLogger().warn(
        { channel, error: error instanceof Error ? error.message : String(error) },
        "notification unsubscribe failed"
      );
    }
  };
}

/** Close every subscriber connection (shutdown). Listener maps are dropped with them. */
export async function closeAllSubscribers(): Promise<void> {
  const states = [...subscribersByUrl.values()];
  subscribersByUrl.clear();
  await Promise.allSettled(
    states.map(async (state) => {
      const client = await state.clientPromise;
      state.listenersByChannel.clear();
      await client.quit();
    })
  );
}

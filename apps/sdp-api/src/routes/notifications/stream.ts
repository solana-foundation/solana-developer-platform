// GET /v1/notifications/stream — the dashboard bell's realtime channel (SSE).
//
// Pushes tiny NotificationInboxNudge events ({unread, ts}) forwarded from Redis
// pub/sub; the client treats them as "refetch now" plus a badge fast-path. The REST
// endpoints stay the only data contract, and the bell's 60s polling is the fallback,
// so everything here is allowed to be best-effort.
//
// Deliberately absent from the OpenAPI spec: dashboard-internal, unusable with
// API-key auth (no user identity → no inbox).

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { rateLimited, unauthorized } from "@/lib/errors";
import { subscribeInbox } from "@/runtime/pubsub-redis";
import { registerSseStream } from "@/runtime/sse-registry";
import type { Env } from "@/types/env";
import { resolveUser } from "./handlers";

type AppContext = Context<{ Bindings: Env }>;

const HEARTBEAT_MS = 25_000;
// Clean self-close below Cloud Run's default 300s request timeout, so the platform
// never cuts the stream mid-flight; EventSource reconnects transparently.
const MAX_AGE_MS = 240_000;
// In-process per-user cap bounds subscriber-router growth from tab explosions.
const MAX_STREAMS_PER_USER = 16;

const openStreamsByUser = new Map<string, number>();

function trackUserStream(key: string): () => void {
  openStreamsByUser.set(key, (openStreamsByUser.get(key) ?? 0) + 1);
  return () => {
    const next = (openStreamsByUser.get(key) ?? 1) - 1;
    if (next <= 0) {
      openStreamsByUser.delete(key);
    } else {
      openStreamsByUser.set(key, next);
    }
  };
}

export const streamNotifications = (c: AppContext) => {
  const user = resolveUser(c);
  if (!user) {
    // API-key auth: no user identity, so no inbox to stream — refuse rather than hold
    // an empty connection open.
    throw unauthorized("Notification stream requires a user session");
  }
  const userKey = `${user.organizationId}:${user.userId}`;
  if ((openStreamsByUser.get(userKey) ?? 0) >= MAX_STREAMS_PER_USER) {
    throw rateLimited("Too many open notification streams");
  }

  return streamSSE(c, async (stream) => {
    // Everything that can end this stream funnels through `finish`: client abort,
    // max-age self-close, and process shutdown (via the SSE registry).
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const untrack = trackUserStream(userKey);
    const unregister = registerSseStream(finish);
    stream.onAbort(finish);

    const unsubscribe = await subscribeInbox(c.env, user.organizationId, user.userId, (nudge) => {
      void stream.writeSSE({ event: "notification", data: JSON.stringify(nudge) });
    });

    // `retry:` tunes EventSource's native reconnect delay for the expected 4-minute
    // self-close cadence.
    await stream.writeSSE({ event: "ready", data: "{}", retry: 3_000 });

    const heartbeat = setInterval(() => {
      // Comment frames keep intermediaries from timing out an idle connection.
      void stream.write(": hb\n\n");
    }, HEARTBEAT_MS);
    const maxAge = setTimeout(finish, MAX_AGE_MS);

    await finished;

    clearInterval(heartbeat);
    clearTimeout(maxAge);
    unregister();
    untrack();
    await unsubscribe();
    // streamSSE closes the response when this callback resolves.
  });
};

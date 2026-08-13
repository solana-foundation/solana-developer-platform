/**
 * Integration tests for the notification pub/sub plumbing against a real Redis
 * (the vitest global setup's container). Exercises the refcounted exact-channel
 * subscribe model end-to-end: publish → subscriber routing → unsubscribe.
 */

import { notificationInboxChannel } from "@sdp/types";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "@/test/helpers/env";
import { closeAllSubscribers, publishInboxNudge, subscribeInbox } from "./pubsub-redis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

async function subscribedChannels(raw: Redis): Promise<string[]> {
  return (await raw.pubsub("CHANNELS", "notifications:inbox:*")) as string[];
}

describe("notification pub/sub (redis)", () => {
  let raw: Redis;

  beforeAll(() => {
    raw = new Redis(REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 3 });
  });

  afterAll(async () => {
    await closeAllSubscribers();
    await raw.quit();
  });

  it("routes a published nudge to the right (org, user) listener only", async () => {
    const received: Array<{ user: string; unread: number }> = [];
    const unsubA = await subscribeInbox(env, "org_ps", "usr_a", (nudge) => {
      received.push({ user: "a", unread: nudge.unread });
    });
    const unsubB = await subscribeInbox(env, "org_ps", "usr_b", (nudge) => {
      received.push({ user: "b", unread: nudge.unread });
    });

    await publishInboxNudge(env, "org_ps", "usr_a", { unread: 3, ts: "t" });
    await vi.waitFor(() => {
      expect(received).toEqual([{ user: "a", unread: 3 }]);
    });

    await unsubA();
    await unsubB();
  });

  it("refcounts the channel subscription across listeners", async () => {
    const channel = notificationInboxChannel("org_rc", "usr_rc");
    const first = await subscribeInbox(env, "org_rc", "usr_rc", () => {});
    const second = await subscribeInbox(env, "org_rc", "usr_rc", () => {});
    await vi.waitFor(async () => {
      expect(await subscribedChannels(raw)).toContain(channel);
    });

    // First listener leaving keeps the channel; the last one releases it.
    await first();
    expect(await subscribedChannels(raw)).toContain(channel);
    await second();
    await vi.waitFor(async () => {
      expect(await subscribedChannels(raw)).not.toContain(channel);
    });
  });

  it("drops malformed publishes without breaking the stream", async () => {
    const received: number[] = [];
    const unsub = await subscribeInbox(env, "org_mf", "usr_mf", (nudge) => {
      received.push(nudge.unread);
    });

    await raw.publish(notificationInboxChannel("org_mf", "usr_mf"), "not json");
    await raw.publish(notificationInboxChannel("org_mf", "usr_mf"), '{"unread":"NaN"}');
    await publishInboxNudge(env, "org_mf", "usr_mf", { unread: 7, ts: "t" });

    await vi.waitFor(() => {
      expect(received).toEqual([7]);
    });
    await unsub();
  });
});

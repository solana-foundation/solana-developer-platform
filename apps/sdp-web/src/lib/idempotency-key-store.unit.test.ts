// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIdempotencyKeyStore,
  resetIdempotencyKeyStoresForTests,
  resolveHeldIdempotencyKey,
} from "./idempotency-key-store";

describe("resolveHeldIdempotencyKey reuse reporting", () => {
  const store = createIdempotencyKeyStore("test:held-key-resolution:v1");
  const fingerprint = "request-fingerprint";
  const liveSignal = new AbortController().signal;

  beforeEach(() => {
    sessionStorage.clear();
    resetIdempotencyKeyStoresForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a freshly minted key as neither held nor reused", async () => {
    const resolution = await resolveHeldIdempotencyKey(
      store,
      fingerprint,
      liveSignal,
      async () => ({ kind: "absent" })
    );

    expect(resolution).toEqual({
      kind: "key",
      key: expect.any(String),
      wasHeld: false,
      wasReused: false,
    });
  });

  it("reports a kept key — one a prior ambiguous attempt left live — as reused", async () => {
    const first = await resolveHeldIdempotencyKey(store, fingerprint, liveSignal, async () => ({
      kind: "absent",
    }));
    // The first answer is discarded, the way a 5xx or a lost transport answer
    // discards it: the key stays live in the store either way.
    const retry = await resolveHeldIdempotencyKey(store, fingerprint, liveSignal, async () => ({
      kind: "absent",
    }));

    if (first.kind !== "key" || retry.kind !== "key") throw new Error("expected key resolutions");
    expect(retry.key).toBe(first.key);
    expect(retry.wasHeld).toBe(false);
    expect(retry.wasReused).toBe(true);
  });

  it("reports a held replay as reused, since the held POST minted that key", async () => {
    const held = store.claim(fingerprint);
    store.hold(fingerprint);

    const resolution = await resolveHeldIdempotencyKey(
      store,
      fingerprint,
      liveSignal,
      async () => ({ kind: "absent" })
    );

    if (resolution.kind !== "key") throw new Error("expected a key resolution");
    expect(resolution.key).toBe(held);
    expect(resolution.wasHeld).toBe(true);
    expect(resolution.wasReused).toBe(true);
  });

  it("answers a fresh key — not a reused one — once a prior attempt's key has lapsed", async () => {
    vi.useFakeTimers();
    try {
      const first = await resolveHeldIdempotencyKey(store, fingerprint, liveSignal, async () => ({
        kind: "absent",
      }));
      // Past the TTL the prior key is dead. The reuse answer comes from the
      // SAME read that produced the key, so a lapsed entry can never stick a
      // reuse flag on a brand-new mint — which would send the previous
      // request's remembered state (the vault flows' floor) under it.
      vi.setSystemTime(Date.now() + 15 * 60_000 + 1_000);
      const retry = await resolveHeldIdempotencyKey(store, fingerprint, liveSignal, async () => ({
        kind: "absent",
      }));

      if (first.kind !== "key" || retry.kind !== "key") throw new Error("expected key resolutions");
      expect(retry.wasReused).toBe(false);
      expect(retry.key).not.toBe(first.key);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands back a fresh key — not a reused one — when the held movement already executed", async () => {
    const spent = store.claim(fingerprint);
    store.hold(fingerprint);

    const resolution = await resolveHeldIdempotencyKey(
      store,
      fingerprint,
      liveSignal,
      async () => ({ kind: "found" })
    );

    if (resolution.kind !== "key") throw new Error("expected a key resolution");
    expect(resolution.wasHeld).toBe(false);
    expect(resolution.wasReused).toBe(false);
    expect(resolution.key).not.toBe(spent);
  });

  it("refuses to answer when the held key's pre-flight read fails", async () => {
    store.claim(fingerprint);
    store.hold(fingerprint);

    const resolution = await resolveHeldIdempotencyKey(
      store,
      fingerprint,
      liveSignal,
      async () => ({ kind: "unavailable" })
    );

    expect(resolution).toEqual({ kind: "unavailable" });
  });

  it("answers aborted when the caller aborts during the held-key pre-flight", async () => {
    store.claim(fingerprint);
    store.hold(fingerprint);
    const controller = new AbortController();

    const resolution = await resolveHeldIdempotencyKey(
      store,
      fingerprint,
      controller.signal,
      () => {
        controller.abort();
        return Promise.resolve({ kind: "absent" });
      }
    );

    expect(resolution).toEqual({ kind: "aborted" });
  });
});

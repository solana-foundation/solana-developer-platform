// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { floorToReplay } from "../app/dashboard/markets/earn/earn-vault-slippage";
import {
  applyIdempotencyKeyOutcome,
  createFloorMemo,
  createIdempotencyKeyStore,
  resetIdempotencyKeyStoresForTests,
  resolveHeldIdempotencyKey,
} from "./idempotency-key-store";
import { RENDERED_PROJECT_SCOPE_MISMATCH_ERROR_CODE } from "./project-cookie";

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

describe("applyIdempotencyKeyOutcome scope refusals", () => {
  const KEY_STORE_KEY = "test:earn:scope-refusal:v1";
  const FINGERPRINT = '["project_1","strategy_1","wallet_1","10",10]';

  let store: ReturnType<typeof createIdempotencyKeyStore>;

  beforeEach(() => {
    sessionStorage.clear();
    resetIdempotencyKeyStoresForTests();
    store = createIdempotencyKeyStore(KEY_STORE_KEY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function scopeRefusal(status = 409) {
    return {
      ok: false as const,
      status,
      error: "Selected project no longer matches the rendered project; reload the page",
      body: {
        error: { code: RENDERED_PROJECT_SCOPE_MISMATCH_ERROR_CODE, message: "refused" },
      },
    };
  }

  it("keeps a key retained for an ambiguous attempt when the BFF refuses the scope", () => {
    // An earlier attempt's outcome was never learned (a 5xx, a lost answer),
    // so the key stays live in the store; the retry then hits the BFF's 409
    // because another tab moved the selection cookie.
    const key = store.claim(FINGERPRINT);

    const disposition = applyIdempotencyKeyOutcome(store, FINGERPRINT, scopeRefusal());

    // The refusal happened before the API: nothing was written and nothing was
    // answered for, so retiring would mint a fresh key on the retry after
    // switching back — a second movement for one intent.
    expect(disposition).toBe("kept");
    expect(store.claim(FINGERPRINT)).toBe(key);
  });

  it("keeps a HELD key on a scope refusal, the same as any other non-answer", () => {
    store.claim(FINGERPRINT);
    store.hold(FINGERPRINT);

    const disposition = applyIdempotencyKeyOutcome(store, FINGERPRINT, scopeRefusal());

    expect(disposition).toBe("kept");
    expect(store.isHeld(FINGERPRINT)).toBe(true);
  });

  it("still retires on the API's own changed-request 409", () => {
    store.claim(FINGERPRINT);

    // The idempotency-conflict escape hatch: a 409 that IS an API answer —
    // no scope-mismatch code in its envelope — retires the key.
    const disposition = applyIdempotencyKeyOutcome(store, FINGERPRINT, {
      ok: false,
      status: 409,
      body: { error: { message: "Idempotency key already used with a different request" } },
    });

    expect(disposition).toBe("retired");
  });
});

describe("FloorMemo partial-write divergence", () => {
  const FLOOR_KEY = "test:earn:floor:v1";
  const KEY_STORE_KEY = "test:earn:idempotency:v1";
  const FINGERPRINT = '["project_1","strategy_1","wallet_1","10",10]';

  function seedReadableStorage(
    key: string,
    value: string,
    setItem: typeof Storage.prototype.setItem
  ): void {
    setItem.call(sessionStorage, key, value);
  }

  beforeEach(() => {
    sessionStorage.clear();
    resetIdempotencyKeyStoresForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replays a floor a quota failure stranded in memory while storage stayed readable", () => {
    const keyStore = createIdempotencyKeyStore(KEY_STORE_KEY);
    const floorMemo = createFloorMemo(FLOOR_KEY);
    const originalSetItem = Storage.prototype.setItem;
    // Quota-shaped asymmetric failure: `setItem` refuses the floor key only,
    // while `getItem` keeps serving the stale previous state.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string
    ) {
      if (key === FLOOR_KEY) throw new Error("QuotaExceededError");
      return originalSetItem.call(this, key, value);
    });

    // State a previous page load left behind: readable, and about to be stale.
    seedReadableStorage(FLOOR_KEY, JSON.stringify({}), originalSetItem);

    const first = keyStore.claimReportingReuse(FINGERPRINT);
    // The non-held branch of `resolveHeldIdempotencyKey`: a plain claim's
    // reuse flag rides the resolution with `wasHeld: false`.
    const firstResolution = { wasHeld: false, wasReused: first.wasReused };
    const fresh = floorToReplay(
      firstResolution,
      (fp) => floorMemo.recall(fp),
      FINGERPRINT,
      "0.99899"
    );
    if (fresh.kind !== "fresh") throw new Error("expected a fresh floor resolution");
    expect(fresh).toEqual({ kind: "fresh", floor: "0.99899" });
    floorMemo.remember(FINGERPRINT, fresh.floor);

    // The first value-moving POST may have been accepted before its response
    // was lost; its key is intentionally kept for an ambiguous retry. The
    // floor-only storage failure must not disturb the key store.
    const retryClaim = keyStore.claimReportingReuse(FINGERPRINT);
    expect(retryClaim.key).toBe(first.key);
    expect(retryClaim.wasReused).toBe(true);

    // The retry must resubmit the floor the key was MINTED with, verbatim —
    // the API's idempotency fingerprint includes it, and a freshly derived
    // floor paired with the reused key retires it and opens a second deposit.
    const retryResolution = { wasHeld: false, wasReused: retryClaim.wasReused };
    const retry = floorToReplay(retryResolution, (fp) => floorMemo.recall(fp), FINGERPRINT, "0.5");
    expect(retry).toEqual({ kind: "replay", floor: "0.99899" });
  });

  it("keeps a forgotten floor forgotten across divergent writes", () => {
    const floorMemo = createFloorMemo(FLOOR_KEY);
    const originalSetItem = Storage.prototype.setItem;

    // The first write succeeds, so storage holds fp-a and is the authority.
    floorMemo.remember("fp-a", "0.999");
    expect(JSON.parse(sessionStorage.getItem(FLOOR_KEY) ?? "{}")).toEqual({ "fp-a": "0.999" });

    // Quota starts refusing floor writes: the next write diverges, and memory
    // becomes the newer snapshot.
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string
    ) {
      if (key === FLOOR_KEY) throw new Error("QuotaExceededError");
      return originalSetItem.call(this, key, value);
    });
    floorMemo.remember("fp-b", "0.99");

    // The forget must stick even though its storage write cannot land: a
    // retired key's floor must not resurface from stale storage.
    floorMemo.forget("fp-a");
    expect(floorMemo.recall("fp-a")).toBeUndefined();
    expect(floorMemo.recall("fp-b")).toBe("0.99");

    // Quota recovers; the next successful write synchronizes the FULL
    // snapshot and returns authority to storage.
    setItem.mockImplementation(originalSetItem);
    floorMemo.remember("fp-c", "0.98");
    expect(floorMemo.recall("fp-a")).toBeUndefined();
    expect(floorMemo.recall("fp-b")).toBe("0.99");
    expect(floorMemo.recall("fp-c")).toBe("0.98");
    expect(JSON.parse(sessionStorage.getItem(FLOOR_KEY) ?? "{}")).toEqual({
      "fp-b": "0.99",
      "fp-c": "0.98",
    });

    // Storage is the authority again: an external clear genuinely clears.
    sessionStorage.removeItem(FLOOR_KEY);
    expect(floorMemo.recall("fp-c")).toBeUndefined();
  });

  it("keeps a normal write readable immediately (negative control)", () => {
    const floorMemo = createFloorMemo(FLOOR_KEY);
    floorMemo.remember("fp", "0.999");
    expect(floorMemo.recall("fp")).toBe("0.999");
    expect(JSON.parse(sessionStorage.getItem(FLOOR_KEY) ?? "{}")).toEqual({ fp: "0.999" });
  });
});

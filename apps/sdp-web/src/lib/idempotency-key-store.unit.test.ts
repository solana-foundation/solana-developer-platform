// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { floorToReplay } from "../app/dashboard/[projectId]/markets/earn/earn-vault-slippage";
import {
  createActionMemo,
  createFloorMemo,
  createIdempotencyKeyStore,
  resetIdempotencyKeyStoresForTests,
} from "./idempotency-key-store";

describe("claimReportingReuse", () => {
  const store = createIdempotencyKeyStore("test:key-reuse:v1");
  const fingerprint = "request-fingerprint";

  beforeEach(() => {
    sessionStorage.clear();
    resetIdempotencyKeyStoresForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a freshly minted key as not reused", () => {
    expect(store.claimReportingReuse(fingerprint)).toEqual({
      key: expect.any(String),
      wasReused: false,
    });
  });

  it("reports a kept key — one a prior ambiguous attempt left live — as reused", () => {
    const first = store.claimReportingReuse(fingerprint);
    // The first answer is discarded, the way a 5xx or a lost transport answer
    // discards it: the key stays live in the store either way.
    const retry = store.claimReportingReuse(fingerprint);

    expect(retry.key).toBe(first.key);
    expect(retry.wasReused).toBe(true);
  });

  it("answers a fresh key — not a reused one — once a prior attempt's key has lapsed", () => {
    vi.useFakeTimers();
    try {
      const first = store.claimReportingReuse(fingerprint);
      // Past the TTL the prior key is dead. The reuse answer comes from the
      // SAME read that produced the key, so a lapsed entry can never stick a
      // reuse flag on a brand-new mint — which would send the previous
      // request's remembered state (the vault flows' floor) under it.
      vi.setSystemTime(Date.now() + 15 * 60_000 + 1_000);
      const retry = store.claimReportingReuse(fingerprint);

      expect(retry.wasReused).toBe(false);
      expect(retry.key).not.toBe(first.key);
    } finally {
      vi.useRealTimers();
    }
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
    // A plain claim's reuse flag decides whether a remembered floor replays.
    const firstResolution = { wasReused: first.wasReused };
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

describe("createActionMemo", () => {
  const memo = createActionMemo("test:action-memo:v1", z.string().nullable());

  beforeEach(() => {
    sessionStorage.clear();
    resetIdempotencyKeyStoresForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("freezes each input's first value, including null, across a reload", () => {
    const build = vi.fn(() => new Date().toISOString());
    const first = memo.valueFor("expiry=1h", build);
    memo.valueFor("expiry=never", () => null);

    resetIdempotencyKeyStoresForTests();

    expect(memo.valueFor("expiry=1h", () => "later")).toBe(first);
    expect(memo.valueFor("expiry=never", () => "later")).toBeNull();
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("stores a digest of the input, never the input itself", () => {
    memo.valueFor("counterparty=Alice Example", () => "value");

    expect(sessionStorage.getItem("test:action-memo:v1")).not.toContain("Alice");
  });

  it("never evicts an unanswered value, however many inputs follow", () => {
    const first = memo.valueFor("input=0", () => "first");
    memo.settle("input=0", "open");
    for (let index = 1; index <= 40; index++) memo.valueFor(`input=${index}`, () => `v${index}`);

    expect(memo.valueFor("input=0", () => "fresh")).toBe(first);
  });

  it("forgets a value on a definitive answer, and on a first attempt's refusal", () => {
    memo.valueFor("a", () => "a1");
    memo.settle("a", "definitive");
    memo.valueFor("b", () => "b1");
    memo.settle("b", "refused");

    expect(memo.valueFor("a", () => "a2")).toBe("a2");
    expect(memo.valueFor("b", () => "b2")).toBe("b2");
  });

  it("keeps the value in memory when storage refuses reads", () => {
    const first = memo.valueFor("a", () => "a1");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    expect(memo.valueFor("a", () => "a2")).toBe(first);
  });

  it("rebuilds a stored value its schema rejects", () => {
    const strict = createActionMemo("test:action-memo-strict:v1", z.string().min(1));
    strict.valueFor("a", () => "kept");
    const raw = sessionStorage.getItem("test:action-memo-strict:v1") ?? "";
    sessionStorage.setItem("test:action-memo-strict:v1", raw.replace('"\\"kept\\""', '"42"'));
    resetIdempotencyKeyStoresForTests();

    expect(strict.valueFor("a", () => "rebuilt")).toBe("rebuilt");
  });
});

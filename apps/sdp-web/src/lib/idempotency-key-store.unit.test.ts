// @vitest-environment jsdom

import type { MoneyMovementStatus } from "@sdp/types/payments";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { floorToReplay } from "@/app/dashboard/[projectId]/markets/earn/earn-vault-slippage";
import { movementStatusOf } from "./idempotency";
import {
  createActionMemo,
  createFloorMemo,
  createIdempotencyKeyStore,
  resetIdempotencyKeyStoresForTests,
  setIdempotencyKeyScope,
  settleMoneyIdempotencyKey,
} from "./idempotency-key-store";

describe("claim", () => {
  const store = createIdempotencyKeyStore("test:key-reuse:v1");
  const fingerprint = "request-fingerprint";

  beforeEach(() => {
    sessionStorage.clear();
    resetIdempotencyKeyStoresForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mints and keeps a key, and hands the kept one to every retry until it is released", () => {
    expect(store.has(fingerprint)).toBe(false);
    const first = store.claim(fingerprint);
    expect(first).toEqual({ key: expect.any(String), persisted: true });
    expect(store.has(fingerprint)).toBe(true);
    expect(store.claim(fingerprint).key).toBe(first.key);

    store.release(fingerprint, first.key);
    expect(store.has(fingerprint)).toBe(false);
    expect(store.claim(fingerprint).key).not.toBe(first.key);
  });

  it("retires only the key an answer was sent under, never a newer one for the same request", () => {
    const first = store.claim(fingerprint).key;
    // A second attempt under the same key is answered first and retires it.
    store.release(fingerprint, first);
    const second = store.claim(fingerprint).key;

    // The first attempt's late answer settles nothing the user has not sent yet.
    store.release(fingerprint, first);
    expect(store.claim(fingerprint).key).toBe(second);
  });

  it("reports a key the browser would not store, and still keeps it for this page", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    const first = store.claim(fingerprint);
    expect(first.persisted).toBe(false);
    expect(store.claim(fingerprint).key).toBe(first.key);
  });
});

// APE-461: a 2xx retired a money key while the movement was still under way,
// so the next identical press minted a new key and paid again.
describe("settleMoneyIdempotencyKey on a movement still under way", () => {
  const store = createIdempotencyKeyStore("test:money-in-flight:v1");
  const fingerprint = "payment-fingerprint";

  beforeEach(() => {
    sessionStorage.clear();
    resetIdempotencyKeyStoresForTests();
  });

  it.each([
    ["a transfer pending", "pending", false],
    ["a transfer processing", "processing", false],
    ["a ramp transfer settling", "settling", false],
    ["a recurring schedule activating", "activating", false],
    ["a recurring schedule updating", "updating", false],
    ["a private-channel transfer submitted", "submitted", false],
    ["a transfer finalized", "finalized", true],
    ["a batch partially failed", "partially_failed", true],
    ["a recurring schedule active", "active", true],
    ["an answer naming no movement", null, true],
  ] as const satisfies readonly (readonly [string, MoneyMovementStatus | null, boolean])[])(
    "%s (%s): retired %s",
    (_label, movementStatus, retired) => {
      const { key } = store.claim(fingerprint);
      for (const replayed of [false, true]) {
        expect(
          settleMoneyIdempotencyKey(store, fingerprint, key, {
            status: 201,
            replayed,
            code: null,
            movementStatus,
          })
        ).toBe(retired);
      }
      expect(store.claim(fingerprint).key === key).toBe(!retired);
    }
  );

  it("reads the in-flight record from a success body", () => {
    expect(movementStatusOf({ data: { transfer: { status: "processing" } } })).toBe("processing");
    expect(
      movementStatusOf({
        data: {
          recurringPayment: { status: "active" },
          collectionAttempt: { status: "processing" },
        },
      })
    ).toBe("processing");
    expect(movementStatusOf({ data: { batch: { status: "confirmed" } } })).toBe("confirmed");
    expect(movementStatusOf({ data: { id: "x" } })).toBeNull();
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

    // Whether a key is kept decides whether a remembered floor replays.
    const firstResolution = { reused: keyStore.has(FINGERPRINT) };
    const first = keyStore.claim(FINGERPRINT);
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
    const retryResolution = { reused: keyStore.has(FINGERPRINT) };
    expect(retryResolution.reused).toBe(true);
    expect(keyStore.claim(FINGERPRINT).key).toBe(first.key);

    // The retry must resubmit the floor the key was MINTED with, verbatim —
    // the API's idempotency fingerprint includes it, and a freshly derived
    // floor paired with the reused key retires it and opens a second deposit.
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
    memo.settle("input=0", first, { status: 503, replayed: false, code: null });
    for (let index = 1; index <= 40; index++) memo.valueFor(`input=${index}`, () => `v${index}`);

    expect(memo.valueFor("input=0", () => "fresh")).toBe(first);
  });

  it("forgets a value on a success, a replay or a 422, and keeps it on a plain refusal", () => {
    memo.valueFor("a", () => "a1");
    memo.settle("a", "a1", { status: 201, replayed: false, code: null });
    memo.valueFor("b", () => "b1");
    memo.settle("b", "b1", { status: 400, replayed: true, code: null });
    memo.valueFor("c", () => "c1");
    memo.settle("c", "c1", { status: 422, replayed: false, code: null });
    memo.valueFor("d", () => "d1");
    memo.settle("d", "d1", { status: 400, replayed: false, code: null });

    expect(memo.valueFor("a", () => "a2")).toBe("a2");
    expect(memo.valueFor("b", () => "b2")).toBe("b2");
    expect(memo.valueFor("c", () => "c2")).toBe("c2");
    expect(memo.valueFor("d", () => "d2")).toBe("d1");
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

describe("user and org scope", () => {
  const store = createIdempotencyKeyStore("test:key-scope:v1");
  const memo = createActionMemo("test:action-memo-scope:v1", z.string());

  beforeEach(() => {
    sessionStorage.clear();
    resetIdempotencyKeyStoresForTests();
  });

  afterEach(() => {
    resetIdempotencyKeyStoresForTests();
  });

  it("never hands user A's unanswered key to user B, or to A in another org", () => {
    setIdempotencyKeyScope("user_a:org_1");
    const { key: keyA, persisted } = store.claim("same-payment");
    expect(persisted).toBe(true);
    const actionKeyA = memo.valueFor("same-label", () => "key-a");

    setIdempotencyKeyScope("user_b:org_1");
    expect(store.has("same-payment")).toBe(false);
    expect(store.claim("same-payment").key).not.toBe(keyA);
    expect(memo.valueFor("same-label", () => "key-b")).toBe("key-b");

    setIdempotencyKeyScope("user_a:org_2");
    expect(store.claim("same-payment").key).not.toBe(keyA);
    expect(memo.valueFor("same-label", () => "key-a-org-2")).toBe("key-a-org-2");

    setIdempotencyKeyScope("user_a:org_1");
    expect(store.claim("same-payment").key).toBe(keyA);
    expect(memo.valueFor("same-label", () => "rebuilt")).toBe(actionKeyA);
  });

  it("settles an answer in the scope that claimed its key, after the user switched org", () => {
    setIdempotencyKeyScope("user_a:org_1");
    const { key: keyA } = store.claim("same-payment");
    setIdempotencyKeyScope("user_a:org_2");
    const { key: keyB } = store.claim("same-payment");

    // Org 1's request answers while org 2 is selected.
    store.release("same-payment", keyA);

    expect(store.claim("same-payment").key).toBe(keyB);
    setIdempotencyKeyScope("user_a:org_1");
    expect(store.has("same-payment")).toBe(false);
  });
});

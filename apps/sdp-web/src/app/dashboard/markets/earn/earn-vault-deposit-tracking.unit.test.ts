// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimVaultDepositIdempotencyKey,
  forgetVaultDepositWatch,
  readVaultDepositWatches,
  releaseVaultDepositIdempotencyKey,
  rememberVaultDepositWatch,
  vaultDepositRequestFingerprint,
} from "./earn-vault-deposit-tracking";

const IDEMPOTENCY_STORE_KEY = "sdp:earn:vault-deposit:idempotency:v1";
const WATCH_STORE_KEY = "sdp:earn:vault-deposit:watch:v1";

const request = {
  strategyId: "strategy_1",
  custodyWalletId: "wallet_1",
  amount: "1",
};

let nextUuid = 0;

beforeEach(() => {
  sessionStorage.clear();
  nextUuid = 0;
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
    nextUuid += 1;
    return `00000000-0000-4000-8000-00000000000${nextUuid}` as `${string}-${string}-${string}-${string}-${string}`;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("vaultDepositRequestFingerprint", () => {
  it("separates a retry from a different deposit", () => {
    const base = vaultDepositRequestFingerprint(request);

    expect(vaultDepositRequestFingerprint({ ...request })).toBe(base);
    for (const different of [
      { ...request, strategyId: "strategy_2" },
      { ...request, custodyWalletId: "wallet_2" },
      { ...request, amount: "2" },
    ]) {
      expect(vaultDepositRequestFingerprint(different)).not.toBe(base);
    }
  });
});

describe("vault deposit idempotency keys", () => {
  it("hands the same key to a retry and a different key to a different deposit", () => {
    const fingerprint = vaultDepositRequestFingerprint(request);

    const first = claimVaultDepositIdempotencyKey(fingerprint);
    expect(claimVaultDepositIdempotencyKey(fingerprint)).toBe(first);
    expect(
      claimVaultDepositIdempotencyKey(vaultDepositRequestFingerprint({ ...request, amount: "2" }))
    ).not.toBe(first);
  });

  it("survives losing every in-memory reference, which is the point of storing it", () => {
    // A reload is exactly this: the component that minted the key is gone and
    // the only thing that can tell a retry from a second deposit is the store.
    const fingerprint = vaultDepositRequestFingerprint(request);
    const beforeReload = claimVaultDepositIdempotencyKey(fingerprint);

    expect(claimVaultDepositIdempotencyKey(fingerprint)).toBe(beforeReload);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it("mints a fresh key once the previous one is retired", () => {
    const fingerprint = vaultDepositRequestFingerprint(request);
    const first = claimVaultDepositIdempotencyKey(fingerprint);

    releaseVaultDepositIdempotencyKey(fingerprint);

    // Not a retry any more: depositing the same amount from the same wallet
    // again is a SECOND deposit, and replaying the old key would silently
    // no-op it.
    expect(claimVaultDepositIdempotencyKey(fingerprint)).not.toBe(first);
  });

  it("expires a key that is far too old to be a retry", () => {
    const fingerprint = vaultDepositRequestFingerprint(request);
    const stale = claimVaultDepositIdempotencyKey(fingerprint);

    const entries = JSON.parse(sessionStorage.getItem(IDEMPOTENCY_STORE_KEY) ?? "[]") as Array<{
      createdAt: number;
    }>;
    entries[0].createdAt = Date.now() - 60 * 60_000;
    sessionStorage.setItem(IDEMPOTENCY_STORE_KEY, JSON.stringify(entries));

    expect(claimVaultDepositIdempotencyKey(fingerprint)).not.toBe(stale);
  });

  it("stays stable in-memory when the browser refuses to store anything", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    // A distinct amount per dead-store test: the in-memory tier is module
    // scope by design, so it outlives `sessionStorage.clear()` between tests.
    const fingerprint = vaultDepositRequestFingerprint({ ...request, amount: "11" });

    const first = claimVaultDepositIdempotencyKey(fingerprint);

    // A refusing store costs DURABILITY, never correctness. Minting again here
    // would make an ambiguous retry a second on-chain deposit — failing soft
    // must not mean failing open.
    expect(first).toBe("00000000-0000-4000-8000-000000000001");
    expect(claimVaultDepositIdempotencyKey(fingerprint)).toBe(first);
    expect(
      claimVaultDepositIdempotencyKey(vaultDepositRequestFingerprint({ ...request, amount: "12" }))
    ).not.toBe(first);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(2);
  });

  it("still retires an in-memory key once the API has answered", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const fingerprint = vaultDepositRequestFingerprint({ ...request, amount: "13" });
    const first = claimVaultDepositIdempotencyKey(fingerprint);

    releaseVaultDepositIdempotencyKey(fingerprint);

    expect(first).toBe("00000000-0000-4000-8000-000000000001");
    expect(claimVaultDepositIdempotencyKey(fingerprint)).not.toBe(first);
  });
});

describe("vault deposit watches", () => {
  it("recovers a watch across a reload and retires it exactly once", () => {
    rememberVaultDepositWatch("movement_1");
    rememberVaultDepositWatch("movement_2");
    rememberVaultDepositWatch("movement_1");

    expect(readVaultDepositWatches()).toEqual(["movement_1", "movement_2"]);

    forgetVaultDepositWatch("movement_1");
    expect(readVaultDepositWatches()).toEqual(["movement_2"]);
    forgetVaultDepositWatch("movement_1");
    expect(readVaultDepositWatches()).toEqual(["movement_2"]);
  });

  it("drops an entry no reconciliation sweep could still be working on", () => {
    rememberVaultDepositWatch("movement_stale");
    const entries = JSON.parse(sessionStorage.getItem(WATCH_STORE_KEY) ?? "[]") as Array<{
      createdAt: number;
    }>;
    entries[0].createdAt = Date.now() - 24 * 60 * 60_000;
    sessionStorage.setItem(WATCH_STORE_KEY, JSON.stringify(entries));

    expect(readVaultDepositWatches()).toEqual([]);
  });

  it("ignores anything in the store it does not fully recognize", () => {
    // Written as often by an older build of this page as by the current one.
    sessionStorage.setItem(
      WATCH_STORE_KEY,
      JSON.stringify([
        { id: "movement_ok", value: "movement_ok", createdAt: Date.now() },
        { id: "movement_no_timestamp", value: "movement_no_timestamp" },
        { value: "movement_no_id", createdAt: Date.now() },
        "movement_bare_string",
        null,
      ])
    );

    expect(readVaultDepositWatches()).toEqual(["movement_ok"]);
  });

  it("returns nothing rather than throwing on an unparseable store", () => {
    sessionStorage.setItem(WATCH_STORE_KEY, "{not json");
    expect(readVaultDepositWatches()).toEqual([]);

    sessionStorage.setItem(WATCH_STORE_KEY, JSON.stringify({ movement_1: true }));
    expect(readVaultDepositWatches()).toEqual([]);
  });
});

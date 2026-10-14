// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetVaultDepositFloor,
  recallVaultDepositFloor,
  rememberVaultDepositFloor,
  resetVaultDepositTrackingStateForTests,
  vaultDepositIdempotencyKeyStore,
  vaultDepositRequestFingerprint,
} from "./earn-vault-deposit-tracking";
import {
  forgetVaultWithdrawalFloor,
  recallVaultWithdrawalFloor,
  rememberVaultWithdrawalFloor,
  vaultWithdrawalIdempotencyKeyStore,
  vaultWithdrawalRequestFingerprint,
} from "./earn-vault-withdraw-tracking";

const IDEMPOTENCY_STORE_KEY = "sdp:earn:vault-deposit:idempotency:v1";

const request = {
  projectId: "prj_1",
  strategyId: "strategy_1",
  custodyWalletId: "wallet_1",
  amount: "1",
  toleranceBps: null,
};

let nextUuid = 0;

beforeEach(() => {
  sessionStorage.clear();
  resetVaultDepositTrackingStateForTests();
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
      // A shared organization-level wallet makes the project the only thing
      // separating these two, which is why it is in the fingerprint.
      { ...request, projectId: "prj_2" },
      { ...request, projectId: null },
      { ...request, strategyId: "strategy_2" },
      { ...request, custodyWalletId: "wallet_2" },
      { ...request, amount: "2" },
      // "Raise the tolerance and retry" is a NEW request and mints a fresh
      // key; the tolerance — unlike the quote-derived floor it produces — is
      // still reproducible from user input after a reload, which is what the
      // store's cross-reload replay rests on.
      { ...request, toleranceBps: 50 },
    ]) {
      expect(vaultDepositRequestFingerprint(different)).not.toBe(base);
    }
  });
});

describe("vault deposit idempotency keys", () => {
  it("hands the same key to a retry and a different key to a different deposit", () => {
    const fingerprint = vaultDepositRequestFingerprint(request);

    const first = vaultDepositIdempotencyKeyStore.claim(fingerprint).key;
    expect(vaultDepositIdempotencyKeyStore.claim(fingerprint).key).toBe(first);
    expect(
      vaultDepositIdempotencyKeyStore.claim(
        vaultDepositRequestFingerprint({ ...request, amount: "2" })
      ).key
    ).not.toBe(first);
  });

  it("survives losing every in-memory reference, which is the point of storing it", () => {
    // A reload is exactly this: the component that minted the key is gone and
    // the only thing that can tell a retry from a second deposit is the store.
    const fingerprint = vaultDepositRequestFingerprint(request);
    const beforeReload = vaultDepositIdempotencyKeyStore.claim(fingerprint).key;

    expect(vaultDepositIdempotencyKeyStore.claim(fingerprint).key).toBe(beforeReload);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it("mints a fresh key once the previous one is retired", () => {
    const fingerprint = vaultDepositRequestFingerprint(request);
    const first = vaultDepositIdempotencyKeyStore.claim(fingerprint).key;

    vaultDepositIdempotencyKeyStore.release(fingerprint, first);

    // Not a retry any more: depositing the same amount from the same wallet
    // again is a SECOND deposit, and replaying the old key would silently
    // no-op it.
    expect(vaultDepositIdempotencyKeyStore.claim(fingerprint).key).not.toBe(first);
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

    const first = vaultDepositIdempotencyKeyStore.claim(fingerprint).key;

    // A refusing store costs DURABILITY, never correctness. Minting again here
    // would make an ambiguous retry a second on-chain deposit — failing soft
    // must not mean failing open.
    expect(first).toBe("00000000-0000-4000-8000-000000000001");
    expect(vaultDepositIdempotencyKeyStore.claim(fingerprint).key).toBe(first);
    expect(
      vaultDepositIdempotencyKeyStore.claim(
        vaultDepositRequestFingerprint({ ...request, amount: "12" })
      ).key
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
    const first = vaultDepositIdempotencyKeyStore.claim(fingerprint).key;

    vaultDepositIdempotencyKeyStore.release(fingerprint, first);

    expect(first).toBe("00000000-0000-4000-8000-000000000001");
    expect(vaultDepositIdempotencyKeyStore.claim(fingerprint).key).not.toBe(first);
  });
});

describe("entries from an earlier build", () => {
  it("keeps an entry an older build wrote", () => {
    // Dropping it as unrecognized would mint a fresh key for a request already
    // in flight.
    const fingerprint = vaultDepositRequestFingerprint(request);
    sessionStorage.setItem(
      IDEMPOTENCY_STORE_KEY,
      JSON.stringify([{ id: fingerprint, value: "legacy-key", createdAt: Date.now() }])
    );

    expect(vaultDepositIdempotencyKeyStore.claim(fingerprint).key).toBe("legacy-key");
  });
});

describe("a quota-diverged storage", () => {
  it("keeps serving the just-claimed key when writes fail but reads still work", () => {
    // The asymmetric failure a quota produces: setItem throws, getItem keeps
    // serving the STALE previous state. Preferring readable storage here
    // un-writes the entry that was just claimed — the next call minted a fresh
    // key for a request already in flight.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const fingerprint = vaultDepositRequestFingerprint(request);

    const first = vaultDepositIdempotencyKeyStore.claim(fingerprint).key;
    expect(vaultDepositIdempotencyKeyStore.claim(fingerprint).key).toBe(first);
  });

  it("hands authority back to storage once a write lands, syncing what failed", () => {
    // Divergence is a state, not a verdict: the next successful write persists
    // the full memory snapshot — including entries whose own writes failed —
    // and storage is the authority again, so external state is honoured.
    const original = Storage.prototype.setItem;
    const failing = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const fingerprint = vaultDepositRequestFingerprint(request);
    const key = vaultDepositIdempotencyKeyStore.claim(fingerprint).key;

    // Quota clears; the next write (a different claim) syncs everything.
    failing.mockImplementation(original);
    vaultDepositIdempotencyKeyStore.claim(
      vaultDepositRequestFingerprint({ ...request, amount: "7" })
    ).key;

    const persisted = JSON.parse(sessionStorage.getItem(IDEMPOTENCY_STORE_KEY) ?? "[]") as Array<{
      id: string;
      value: string;
    }>;
    expect(persisted.find((entry) => entry.id === fingerprint)?.value).toBe(key);

    // Storage is authoritative again: an external edit is honoured, not
    // shadowed by memory.
    sessionStorage.setItem(IDEMPOTENCY_STORE_KEY, JSON.stringify([]));
    expect(vaultDepositIdempotencyKeyStore.claim(fingerprint).key).not.toBe(key);
  });
});

describe("storage bound", () => {
  it("never evicts a kept key, however many requests follow it", () => {
    const keptFingerprint = vaultDepositRequestFingerprint(request);
    const kept = vaultDepositIdempotencyKeyStore.claim(keptFingerprint).key;
    for (let index = 0; index < 40; index += 1) {
      vaultDepositIdempotencyKeyStore.claim(
        vaultDepositRequestFingerprint({ ...request, amount: `10${index}` })
      ).key;
    }
    expect(vaultDepositIdempotencyKeyStore.claim(keptFingerprint).key).toBe(kept);
  });

  it("drops an entry the store cannot recognize as a whole entry", () => {
    const fingerprint = vaultDepositRequestFingerprint(request);
    sessionStorage.setItem(
      IDEMPOTENCY_STORE_KEY,
      JSON.stringify([{ id: fingerprint, value: "" }, { id: "", value: "ok" }, { value: "ok" }])
    );

    // None of the three parse, so nothing is reused and a fresh key is minted.
    expect(vaultDepositIdempotencyKeyStore.claim(fingerprint).key).toBe(
      "00000000-0000-4000-8000-000000000001"
    );
  });
});

describe("the floor memo", () => {
  const fingerprint = vaultDepositRequestFingerprint({ ...request, toleranceBps: 10 });

  it("replays the floor a key was minted with, across a reload", () => {
    rememberVaultDepositFloor(fingerprint, "0.99899");
    // A reload is exactly this: every in-memory reference is gone and the
    // fresh quote would derive a DIFFERENT floor the API's fingerprint
    // refuses under the held key.
    expect(recallVaultDepositFloor(fingerprint)).toBe("0.99899");
  });

  it("distinguishes a remembered null floor from nothing remembered", () => {
    rememberVaultDepositFloor(fingerprint, null);
    expect(recallVaultDepositFloor(fingerprint)).toBeNull();
    forgetVaultDepositFloor(fingerprint);
    expect(recallVaultDepositFloor(fingerprint)).toBeUndefined();
  });

  // Greptile (#2333): a late answer to an earlier attempt retired nothing new,
  // yet erased the floor the newer kept key replays, so its retry stopped.
  it("keeps a newer key's floor when a late answer settles an earlier attempt", () => {
    const first = vaultDepositIdempotencyKeyStore.claim(fingerprint).key;
    rememberVaultDepositFloor(fingerprint, "0.9");
    // A retry under the same key is answered first and retires it.
    vaultDepositIdempotencyKeyStore.release(fingerprint, first);
    forgetVaultDepositFloor(fingerprint);
    rememberVaultDepositFloor(fingerprint, "0.8");
    vaultDepositIdempotencyKeyStore.claim(fingerprint);

    // The first attempt's late answer.
    vaultDepositIdempotencyKeyStore.release(fingerprint, first);
    forgetVaultDepositFloor(fingerprint);

    expect(recallVaultDepositFloor(fingerprint)).toBe("0.8");
  });

  it("keeps a newer withdrawal key's floor on the same rule", () => {
    const exit = vaultWithdrawalRequestFingerprint({
      projectId: "prj_1",
      positionId: "pos_1",
      shares: "1",
      toleranceBps: 10,
    });
    const first = vaultWithdrawalIdempotencyKeyStore.claim(exit).key;
    vaultWithdrawalIdempotencyKeyStore.release(exit, first);
    rememberVaultWithdrawalFloor(exit, "0.8");
    vaultWithdrawalIdempotencyKeyStore.claim(exit);

    vaultWithdrawalIdempotencyKeyStore.release(exit, first);
    forgetVaultWithdrawalFloor(exit);

    expect(recallVaultWithdrawalFloor(exit)).toBe("0.8");
  });

  it("keeps serving in memory when the browser refuses to store anything", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    rememberVaultDepositFloor(fingerprint, "1.5");
    expect(recallVaultDepositFloor(fingerprint)).toBe("1.5");
  });
});

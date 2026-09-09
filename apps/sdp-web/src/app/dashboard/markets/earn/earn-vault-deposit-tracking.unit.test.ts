// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimVaultDepositIdempotencyKey,
  forgetVaultDepositFloor,
  holdVaultDepositIdempotencyKey,
  isVaultDepositIdempotencyKeyHeld,
  recallVaultDepositFloor,
  releaseVaultDepositIdempotencyKey,
  rememberVaultDepositFloor,
  resetVaultDepositTrackingStateForTests,
  vaultDepositRequestFingerprint,
} from "./earn-vault-deposit-tracking";

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

describe("an approval hold suspends expiry", () => {
  it("keeps the key past the default TTL, because a human is the clock", () => {
    const fingerprint = vaultDepositRequestFingerprint(request);
    const held = claimVaultDepositIdempotencyKey(fingerprint);
    holdVaultDepositIdempotencyKey(fingerprint);

    // Two hours later — far past the 15-minute default, which is calibrated to
    // a blockhash and means nothing to an approval sitting in someone's queue.
    const entries = JSON.parse(sessionStorage.getItem(IDEMPOTENCY_STORE_KEY) ?? "[]") as Array<{
      createdAt: number;
      expiresAt?: number | null;
    }>;
    entries[0].createdAt = Date.now() - 2 * 60 * 60_000;
    sessionStorage.setItem(IDEMPOTENCY_STORE_KEY, JSON.stringify(entries));

    // A fresh key here would open a SECOND approval request for one intent.
    expect(claimVaultDepositIdempotencyKey(fingerprint)).toBe(held);
  });

  it("still retires a held key once the API answers", () => {
    const fingerprint = vaultDepositRequestFingerprint(request);
    const held = claimVaultDepositIdempotencyKey(fingerprint);
    holdVaultDepositIdempotencyKey(fingerprint);

    releaseVaultDepositIdempotencyKey(fingerprint);

    expect(claimVaultDepositIdempotencyKey(fingerprint)).not.toBe(held);
  });

  it("does nothing for a request that was never claimed", () => {
    holdVaultDepositIdempotencyKey(vaultDepositRequestFingerprint(request));
    expect(sessionStorage.getItem(IDEMPOTENCY_STORE_KEY)).toBeNull();
  });

  it("keeps an entry written before this field existed working under the default TTL", () => {
    // Forward compatibility runs both ways: an entry from an older build has no
    // `expiresAt`, and dropping it as unrecognized would mint a fresh key for a
    // request already in flight.
    const fingerprint = vaultDepositRequestFingerprint(request);
    sessionStorage.setItem(
      IDEMPOTENCY_STORE_KEY,
      JSON.stringify([{ id: fingerprint, value: "legacy-key", createdAt: Date.now() }])
    );

    expect(claimVaultDepositIdempotencyKey(fingerprint)).toBe("legacy-key");
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

    const first = claimVaultDepositIdempotencyKey(fingerprint);
    expect(claimVaultDepositIdempotencyKey(fingerprint)).toBe(first);
  });

  it("keeps a hold visible when its write never reached storage", () => {
    // The absorbed-by-approval detection and the spent-key pre-flight both key
    // off "was this held" — losing the marker presents an executed approval
    // replay as a fresh successful submission.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const fingerprint = vaultDepositRequestFingerprint(request);
    claimVaultDepositIdempotencyKey(fingerprint);

    holdVaultDepositIdempotencyKey(fingerprint);

    expect(isVaultDepositIdempotencyKeyHeld(fingerprint)).toBe(true);
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
    const key = claimVaultDepositIdempotencyKey(fingerprint);

    // Quota clears; the next write (a different claim) syncs everything.
    failing.mockImplementation(original);
    claimVaultDepositIdempotencyKey(vaultDepositRequestFingerprint({ ...request, amount: "7" }));

    const persisted = JSON.parse(sessionStorage.getItem(IDEMPOTENCY_STORE_KEY) ?? "[]") as Array<{
      id: string;
      value: string;
    }>;
    expect(persisted.find((entry) => entry.id === fingerprint)?.value).toBe(key);

    // Storage is authoritative again: an external edit is honoured, not
    // shadowed by memory.
    sessionStorage.setItem(IDEMPOTENCY_STORE_KEY, JSON.stringify([]));
    expect(claimVaultDepositIdempotencyKey(fingerprint)).not.toBe(key);
  });
});

describe("storage bound", () => {
  it("evicts expiring keys before a key an approval is waiting on", () => {
    // The hazard: a held key dropped by a plain "keep newest N" mints a fresh
    // key on the next submit, which opens a SECOND approval for one intent.
    const heldFingerprint = vaultDepositRequestFingerprint(request);
    const held = claimVaultDepositIdempotencyKey(heldFingerprint);
    holdVaultDepositIdempotencyKey(heldFingerprint);

    // Push well past the 20-entry cap with ordinary, expiring entries.
    for (let index = 0; index < 40; index += 1) {
      claimVaultDepositIdempotencyKey(
        vaultDepositRequestFingerprint({ ...request, amount: `10${index}` })
      );
    }

    expect(claimVaultDepositIdempotencyKey(heldFingerprint)).toBe(held);
  });

  it("never evicts a held key, however many approvals are pending", () => {
    // The cap governs EXPIRING entries. A held key is an approval still parked
    // server-side under that exact value: dropping it mints a fresh key on the
    // next submit, opening a second approval request for one intent. Losing an
    // expiring entry costs a replay; losing this one can deposit twice.
    const fingerprints = Array.from({ length: 30 }, (_, index) =>
      vaultDepositRequestFingerprint({ ...request, amount: `20${index}` })
    );
    const keys = fingerprints.map((fingerprint) => {
      const key = claimVaultDepositIdempotencyKey(fingerprint);
      holdVaultDepositIdempotencyKey(fingerprint);
      return key;
    });

    // Every one of them, including the OLDEST — the entry a shared cap dropped.
    for (const [index, fingerprint] of fingerprints.entries()) {
      expect(claimVaultDepositIdempotencyKey(fingerprint)).toBe(keys[index]);
    }
  });

  it("gives up the OLDEST expiring entry when held keys fill the cap", () => {
    const heldFingerprints = Array.from({ length: 20 }, (_, index) =>
      vaultDepositRequestFingerprint({ ...request, amount: `30${index}` })
    );
    for (const fingerprint of heldFingerprints) {
      claimVaultDepositIdempotencyKey(fingerprint);
      holdVaultDepositIdempotencyKey(fingerprint);
    }

    const olderFingerprint = vaultDepositRequestFingerprint({ ...request, amount: "998" });
    const older = claimVaultDepositIdempotencyKey(olderFingerprint);
    const newerFingerprint = vaultDepositRequestFingerprint({ ...request, amount: "999" });
    const newer = claimVaultDepositIdempotencyKey(newerFingerprint);

    // The newest expiring entry always survives — it is the key `claim` just
    // handed back, and returning a key that was never stored would let the next
    // call silently replace it.
    expect(claimVaultDepositIdempotencyKey(newerFingerprint)).toBe(newer);
    // The older one is the honest thing to surrender: a stale expiring key risks
    // only a replay, which the API reports as `replayed`.
    expect(claimVaultDepositIdempotencyKey(olderFingerprint)).not.toBe(older);
    // And every held key is untouched.
    expect(claimVaultDepositIdempotencyKey(heldFingerprints[0] as string)).toBeTruthy();
  });

  it("drops an entry the store cannot recognize as a whole entry", () => {
    const fingerprint = vaultDepositRequestFingerprint(request);
    sessionStorage.setItem(
      IDEMPOTENCY_STORE_KEY,
      JSON.stringify([
        { id: fingerprint, value: "", createdAt: Date.now() },
        { id: fingerprint, value: "ok", createdAt: "not-a-number" },
        { id: fingerprint, value: "ok", createdAt: Date.now(), expiresAt: "soon" },
      ])
    );

    // None of the three parse, so nothing is reused and a fresh key is minted.
    expect(claimVaultDepositIdempotencyKey(fingerprint)).toBe(
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

  it("bounds abandoned entries instead of growing without limit", () => {
    for (let index = 0; index < 40; index += 1) {
      rememberVaultDepositFloor(
        vaultDepositRequestFingerprint({ ...request, amount: `40${index}` }),
        "1"
      );
    }
    // The oldest fell off; the newest is intact.
    expect(
      recallVaultDepositFloor(vaultDepositRequestFingerprint({ ...request, amount: "400" }))
    ).toBeUndefined();
    expect(
      recallVaultDepositFloor(vaultDepositRequestFingerprint({ ...request, amount: "4039" }))
    ).toBe("1");
  });
});

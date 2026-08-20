// @vitest-environment jsdom
import type { PaymentTransferBatchRequest } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimTransferBatchIdempotencyKey,
  holdTransferBatchIdempotencyKey,
  releaseTransferBatchIdempotencyKey,
  resetTransferBatchIdempotencyStateForTests,
  transferBatchRequestFingerprint,
} from "./transfer-batch-idempotency";

function batchRequest(
  overrides: Partial<PaymentTransferBatchRequest> = {}
): PaymentTransferBatchRequest {
  return {
    source: "wallet_1",
    token: "USDC",
    recipients: [
      { counterpartyId: "cp_1", counterpartyAccountId: "acct_1", amount: "1.5" },
      { counterpartyId: "cp_2", counterpartyAccountId: "acct_2", amount: "2" },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetTransferBatchIdempotencyStateForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("transferBatchRequestFingerprint", () => {
  it("is stable across recipient selection order", () => {
    const forward = batchRequest();
    const reversed = batchRequest({ recipients: [...forward.recipients].reverse() });
    expect(transferBatchRequestFingerprint(forward)).toBe(
      transferBatchRequestFingerprint(reversed)
    );
  });

  it("differs when any part of the intent changes", () => {
    const base = transferBatchRequestFingerprint(batchRequest());
    expect(transferBatchRequestFingerprint(batchRequest({ source: "wallet_2" }))).not.toBe(base);
    expect(transferBatchRequestFingerprint(batchRequest({ token: "SOL" }))).not.toBe(base);
    expect(transferBatchRequestFingerprint(batchRequest({ externalId: "ref-1" }))).not.toBe(base);
    expect(
      transferBatchRequestFingerprint(
        batchRequest({
          recipients: [{ counterpartyId: "cp_1", counterpartyAccountId: "acct_1", amount: "9" }],
        })
      )
    ).not.toBe(base);
  });
});

describe("claim / release", () => {
  it("returns the same key for the same fingerprint until released", () => {
    const fingerprint = transferBatchRequestFingerprint(batchRequest());
    const first = claimTransferBatchIdempotencyKey(fingerprint);
    expect(claimTransferBatchIdempotencyKey(fingerprint)).toBe(first);

    releaseTransferBatchIdempotencyKey(fingerprint);
    expect(claimTransferBatchIdempotencyKey(fingerprint)).not.toBe(first);
  });

  it("mints distinct keys for distinct fingerprints", () => {
    const a = claimTransferBatchIdempotencyKey("fingerprint-a");
    const b = claimTransferBatchIdempotencyKey("fingerprint-b");
    expect(a).not.toBe(b);
  });

  it("survives what a reload leaves behind: the sessionStorage snapshot", () => {
    const fingerprint = transferBatchRequestFingerprint(batchRequest());
    const key = claimTransferBatchIdempotencyKey(fingerprint);
    // A reload loses module state but keeps sessionStorage.
    resetTransferBatchIdempotencyStateForTests();
    expect(claimTransferBatchIdempotencyKey(fingerprint)).toBe(key);
  });

  it("expires an unheld key after the TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));
    const fingerprint = "fingerprint-ttl";
    const key = claimTransferBatchIdempotencyKey(fingerprint);

    vi.setSystemTime(new Date("2026-08-20T12:14:00Z"));
    expect(claimTransferBatchIdempotencyKey(fingerprint)).toBe(key);

    vi.setSystemTime(new Date("2026-08-20T12:16:00Z"));
    expect(claimTransferBatchIdempotencyKey(fingerprint)).not.toBe(key);
  });
});

describe("hold", () => {
  it("suspends expiry while an approval is pending", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));
    const fingerprint = "fingerprint-held";
    const key = claimTransferBatchIdempotencyKey(fingerprint);
    holdTransferBatchIdempotencyKey(fingerprint);

    // Hours later — far past the 15-minute TTL — the held key still answers.
    vi.setSystemTime(new Date("2026-08-20T18:00:00Z"));
    expect(claimTransferBatchIdempotencyKey(fingerprint)).toBe(key);

    releaseTransferBatchIdempotencyKey(fingerprint);
    expect(claimTransferBatchIdempotencyKey(fingerprint)).not.toBe(key);
  });

  it("never evicts a held entry under expiring-entry churn", () => {
    const heldFingerprint = "fingerprint-held-under-churn";
    const heldKey = claimTransferBatchIdempotencyKey(heldFingerprint);
    holdTransferBatchIdempotencyKey(heldFingerprint);

    for (let index = 0; index < 40; index += 1) {
      claimTransferBatchIdempotencyKey(`fingerprint-churn-${index}`);
    }

    expect(claimTransferBatchIdempotencyKey(heldFingerprint)).toBe(heldKey);
  });
});

describe("degraded storage", () => {
  it("keeps the key stable in memory when sessionStorage refuses writes", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    try {
      const fingerprint = "fingerprint-quota";
      const key = claimTransferBatchIdempotencyKey(fingerprint);
      expect(claimTransferBatchIdempotencyKey(fingerprint)).toBe(key);
    } finally {
      setItem.mockRestore();
    }
  });

  it("prefers memory over stale readable storage after a failed write", () => {
    const fingerprint = "fingerprint-diverged";
    const stale = claimTransferBatchIdempotencyKey(fingerprint);
    releaseTransferBatchIdempotencyKey(fingerprint);

    // The release reached storage; now the NEXT claim's write fails, leaving
    // storage stale while memory holds the fresh key.
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    try {
      const fresh = claimTransferBatchIdempotencyKey(fingerprint);
      expect(fresh).not.toBe(stale);
      expect(claimTransferBatchIdempotencyKey(fingerprint)).toBe(fresh);
    } finally {
      setItem.mockRestore();
    }
  });
});

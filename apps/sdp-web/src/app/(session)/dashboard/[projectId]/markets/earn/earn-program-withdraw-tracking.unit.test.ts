// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
import {
  programWithdrawalIdempotencyKeyStore,
  programWithdrawalRequestFingerprint,
  withdrawalRequestSignature,
} from "./earn-program-withdraw-tracking";

const request = {
  projectId: "prj_1",
  programId: "earn_program_1",
  amountUsd: "12.50",
  token: "usdc" as const,
  destinationAddress: "11111111111111111111111111111111",
};

let nextUuid = 0;

beforeEach(() => {
  sessionStorage.clear();
  resetIdempotencyKeyStoresForTests();
  nextUuid = 0;
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
    nextUuid += 1;
    return `00000000-0000-4000-8000-00000000000${nextUuid}` as `${string}-${string}-${string}-${string}-${string}`;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("withdrawalRequestSignature", () => {
  it("keeps every spelling of one amount on one key", () => {
    // "12.50", "12.5" and "012.50" are the same intended withdrawal. A
    // cosmetic edit after an ambiguous failure — a 5xx that may already be
    // recorded — must replay the original key (the provider collapses the
    // duplicate), not mint a fresh one and pay the withdrawal a second time.
    const signature = withdrawalRequestSignature(
      request.programId,
      request.amountUsd,
      request.token,
      request.destinationAddress
    );
    for (const respelling of ["12.5", "012.50", "12.500"]) {
      expect(
        withdrawalRequestSignature(
          request.programId,
          respelling,
          request.token,
          request.destinationAddress
        )
      ).toBe(signature);
    }
    // Only a VALUE change may mint a new key.
    expect(
      withdrawalRequestSignature(
        request.programId,
        "12.5001",
        request.token,
        request.destinationAddress
      )
    ).not.toBe(signature);
  });

  it("changes whenever the intended withdrawal changes", () => {
    const signature = withdrawalRequestSignature(
      request.programId,
      request.amountUsd,
      request.token,
      request.destinationAddress
    );
    expect(
      withdrawalRequestSignature(
        "earn_program_2",
        request.amountUsd,
        request.token,
        request.destinationAddress
      )
    ).not.toBe(signature);
    expect(
      withdrawalRequestSignature(
        request.programId,
        request.amountUsd,
        "usdt",
        request.destinationAddress
      )
    ).not.toBe(signature);
    expect(
      withdrawalRequestSignature(
        request.programId,
        request.amountUsd,
        request.token,
        "22222222222222222222222222222222"
      )
    ).not.toBe(signature);
  });
});

describe("programWithdrawalRequestFingerprint", () => {
  it("separates a retry from a different withdrawal", () => {
    const base = programWithdrawalRequestFingerprint(request);

    expect(programWithdrawalRequestFingerprint({ ...request })).toBe(base);
    for (const different of [
      // Sibling projects reach the same program, so the project is in the
      // fingerprint: a key minted under one must never resolve the other's
      // identical-looking withdrawal as its replay.
      { ...request, projectId: "prj_2" },
      { ...request, projectId: null },
      { ...request, programId: "earn_program_2" },
      { ...request, amountUsd: "13.00" },
      { ...request, token: "usdt" as const },
      { ...request, destinationAddress: "22222222222222222222222222222222" },
    ]) {
      expect(programWithdrawalRequestFingerprint(different)).not.toBe(base);
    }
  });

  it("never stores the destination address in the clear", () => {
    // The fingerprint is the store's entry id, and the store writes to
    // `sessionStorage` at claim time. The address is public on-chain data,
    // but it is the payer's counterparty all the same — hashed here for the
    // same reason the per-action layer hashes its material.
    const fingerprint = programWithdrawalRequestFingerprint(request);
    expect(fingerprint).not.toContain(request.destinationAddress);

    programWithdrawalIdempotencyKeyStore.claim(fingerprint);
    const stored = sessionStorage.getItem("sdp:earn:program-withdrawal:idempotency:v1") ?? "";
    expect(stored).not.toBe("");
    expect(stored).not.toContain(request.destinationAddress);
  });
});

describe("program withdrawal idempotency keys", () => {
  it("hands the same key to a retry and a different key to a different withdrawal", () => {
    const fingerprint = programWithdrawalRequestFingerprint(request);

    const first = programWithdrawalIdempotencyKeyStore.claim(fingerprint).key;
    expect(programWithdrawalIdempotencyKeyStore.claim(fingerprint).key).toBe(first);
    expect(
      programWithdrawalIdempotencyKeyStore.claim(
        programWithdrawalRequestFingerprint({ ...request, amountUsd: "13.00" })
      ).key
    ).not.toBe(first);
  });

  it("survives losing every in-memory reference, which is the point of storing it", () => {
    // A remount or a reload is exactly this: the component that minted the
    // key is gone and the only thing that can tell a retry from a SECOND
    // withdrawal is the store. The ref-based key this store replaced minted
    // again here and could pay the intent twice.
    const fingerprint = programWithdrawalRequestFingerprint(request);
    const beforeReload = programWithdrawalIdempotencyKeyStore.claim(fingerprint).key;

    expect(programWithdrawalIdempotencyKeyStore.claim(fingerprint).key).toBe(beforeReload);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it("mints a fresh key once the previous one is retired", () => {
    const fingerprint = programWithdrawalRequestFingerprint(request);
    const first = programWithdrawalIdempotencyKeyStore.claim(fingerprint).key;

    programWithdrawalIdempotencyKeyStore.release(fingerprint, first);

    // Not a retry any more: withdrawing the same amount to the same address
    // again is a SECOND withdrawal, and replaying the old key would silently
    // no-op it.
    expect(programWithdrawalIdempotencyKeyStore.claim(fingerprint).key).not.toBe(first);
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
    const fingerprint = programWithdrawalRequestFingerprint({ ...request, amountUsd: "21" });

    const first = programWithdrawalIdempotencyKeyStore.claim(fingerprint).key;

    // A refusing store costs DURABILITY, never correctness. Minting again
    // here would make an ambiguous retry a second payout — failing soft must
    // not mean failing open. (The modal refuses to send at all when the key
    // did not persist.)
    expect(first).toBe("00000000-0000-4000-8000-000000000001");
    expect(programWithdrawalIdempotencyKeyStore.claim(fingerprint).key).toBe(first);
    expect(
      programWithdrawalIdempotencyKeyStore.claim(
        programWithdrawalRequestFingerprint({ ...request, amountUsd: "22" })
      ).key
    ).not.toBe(first);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(2);
  });
});

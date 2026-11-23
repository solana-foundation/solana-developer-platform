// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  forgetVaultWithdrawalFloor,
  forgetVaultWithdrawalShares,
  recallVaultWithdrawalFloor,
  recallVaultWithdrawalKeptAttempt,
  recallVaultWithdrawalShares,
  rememberVaultWithdrawalFloor,
  rememberVaultWithdrawalShares,
  resetVaultWithdrawalTrackingStateForTests,
  resolveVaultWithdrawalKeptKey,
  type VaultWithdrawalRecovery,
  vaultWithdrawalIdempotencyKeyStore,
  vaultWithdrawalRequestFingerprint,
} from "./earn-vault-withdraw-tracking";

const LEGACY_KEY = "00000000-0000-4000-8000-000000000000";
const FIRST_KEY = "00000000-0000-4000-8000-000000000001";

// The PREVIOUS build's identity: the DERIVED shares where this build keeps
// the typed dollar amount, no format tag.
const legacyAtomicFingerprint = JSON.stringify(["project_1", "position_1", "5", 50]);
const legacyInstantFingerprint = JSON.stringify(["project_1", "position_1", "5", 50, "instant"]);

function atomicFingerprint(
  quantity = "5",
  toleranceBps: number | null = 50,
  redemptionMode?: "standard" | "instant"
): string {
  return vaultWithdrawalRequestFingerprint({
    projectId: "project_1",
    positionId: "position_1",
    quantity,
    toleranceBps,
    redemptionMode,
  });
}

function recoveryScope(redemptionMode?: "standard" | "instant") {
  return { projectId: "project_1", positionId: "position_1", redemptionMode };
}

beforeEach(() => {
  sessionStorage.clear();
  resetVaultWithdrawalTrackingStateForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("vaultWithdrawalRequestFingerprint", () => {
  it("keys the atomic exit on the TYPED dollar amount behind a format tag", () => {
    expect(atomicFingerprint()).toBe(
      JSON.stringify(["typed-quantity-1", "project_1", "position_1", "5", 50])
    );
  });

  it("appends the redemption mode only when one is set", () => {
    expect(atomicFingerprint("5", 50, "instant")).toBe(
      JSON.stringify(["typed-quantity-1", "project_1", "position_1", "5", 50, "instant"])
    );
  });

  it.each([
    ["quantity", "6", 50, undefined],
    ["tolerance", "5", 80, undefined],
    ["redemption mode", "5", 50, "instant"],
  ] as const)("changes when the %s changes", (_label, quantity, toleranceBps, redemptionMode) => {
    expect(atomicFingerprint(quantity, toleranceBps, redemptionMode)).not.toBe(atomicFingerprint());
  });
});

describe("recallVaultWithdrawalKeptAttempt", () => {
  it("adopts the previous build's unresolved attempt with its memo'd floor", () => {
    vaultWithdrawalIdempotencyKeyStore.claim(legacyAtomicFingerprint, () => LEGACY_KEY);
    rememberVaultWithdrawalFloor(legacyAtomicFingerprint, "4.9");
    expect(recallVaultWithdrawalKeptAttempt(recoveryScope())).toEqual({
      fingerprint: legacyAtomicFingerprint,
      floor: "4.9",
      shares: "5",
    });
  });

  it("adopts a legacy instant attempt for that mode only", () => {
    vaultWithdrawalIdempotencyKeyStore.claim(legacyInstantFingerprint, () => LEGACY_KEY);
    expect(recallVaultWithdrawalKeptAttempt(recoveryScope("instant"))).toEqual({
      fingerprint: legacyInstantFingerprint,
      floor: undefined,
      shares: "5",
    });
    expect(recallVaultWithdrawalKeptAttempt(recoveryScope())).toBeUndefined();
  });

  it("adopts this build's kept entry minted under a customized tolerance", () => {
    // The reload stranding the recovery exists for: the modal re-seeds the
    // tolerance control to the provider's default at mount, so the kept key
    // under the CUSTOMIZED tolerance is reachable through no fingerprint the
    // form can recompute. The scan adopts it; the memos carry the minted
    // shares and floor the replay must send.
    const customized = atomicFingerprint("5", 80);
    vaultWithdrawalIdempotencyKeyStore.claim(customized, () => FIRST_KEY);
    rememberVaultWithdrawalFloor(customized, "4.8");
    rememberVaultWithdrawalShares(customized, "5.01");
    expect(recallVaultWithdrawalKeptAttempt(recoveryScope())).toEqual({
      fingerprint: customized,
      floor: "4.8",
      shares: "5.01",
    });
  });

  it("adopts this build's kept entry with LOST memos as nothing sendable", () => {
    // Another tab (or a refused store) holds no memos for the kept key: the
    // adoption must still surface — a skipped entry would invite the
    // mint-over — and the undefined members stop the submit instead.
    const customized = atomicFingerprint("9", 80);
    vaultWithdrawalIdempotencyKeyStore.claim(customized, () => FIRST_KEY);
    expect(recallVaultWithdrawalKeptAttempt(recoveryScope())).toEqual({
      fingerprint: customized,
      floor: undefined,
      shares: undefined,
    });
  });

  it("adopts the OLDEST kept attempt first across both shapes", () => {
    // Claim times decide the order, not the shapes: the scan answers the
    // first attempt first, whichever build wrote it.
    const clock = vi.spyOn(Date, "now");
    let nowMs = 1_000_000;
    clock.mockImplementation(() => (nowMs += 1));
    const own = atomicFingerprint();
    vaultWithdrawalIdempotencyKeyStore.claim(own, () => FIRST_KEY);
    nowMs += 10_000;
    vaultWithdrawalIdempotencyKeyStore.claim(legacyAtomicFingerprint, () => LEGACY_KEY);
    clock.mockRestore();
    expect(recallVaultWithdrawalKeptAttempt(recoveryScope())?.fingerprint).toBe(own);
    // And once the oldest is answered, the re-scan walks to the next one.
    vaultWithdrawalIdempotencyKeyStore.release(own, FIRST_KEY);
    expect(recallVaultWithdrawalKeptAttempt(recoveryScope())?.fingerprint).toBe(
      legacyAtomicFingerprint
    );
  });

  it("matches the project and position, and refuses entries of other scopes", () => {
    vaultWithdrawalIdempotencyKeyStore.claim(legacyAtomicFingerprint, () => LEGACY_KEY);
    const own = atomicFingerprint();
    vaultWithdrawalIdempotencyKeyStore.claim(own, () => FIRST_KEY);
    expect(
      recallVaultWithdrawalKeptAttempt({ ...recoveryScope(), projectId: "project_2" })
    ).toBeUndefined();
    expect(
      recallVaultWithdrawalKeptAttempt({ ...recoveryScope(), positionId: "position_2" })
    ).toBeUndefined();
  });

  it("never adopts a provider-order entry", () => {
    // A provider order's identity carries a null tolerance — the shape an
    // atomic exit under a live policy can never write (a missing floor
    // disables the confirm), so the number check keeps the two settlements'
    // entries apart.
    const providerOrder = atomicFingerprint("5", null);
    vaultWithdrawalIdempotencyKeyStore.claim(providerOrder, () => FIRST_KEY);
    expect(recallVaultWithdrawalKeptAttempt(recoveryScope())).toBeUndefined();
  });

  it("ignores fingerprints that parse to neither shape", () => {
    vaultWithdrawalIdempotencyKeyStore.claim("not json at all", () => FIRST_KEY);
    vaultWithdrawalIdempotencyKeyStore.claim(JSON.stringify([1, 2, 3]), () => FIRST_KEY);
    expect(recallVaultWithdrawalKeptAttempt(recoveryScope())).toBeUndefined();
  });
});

describe("resolveVaultWithdrawalKeptKey", () => {
  it("mints fresh for an unknown fingerprint and reports a kept key's reuse", () => {
    const fingerprint = atomicFingerprint();
    expect(resolveVaultWithdrawalKeptKey({ fingerprint })).toEqual({
      fingerprint,
      reused: false,
    });
    vaultWithdrawalIdempotencyKeyStore.claim(fingerprint, () => FIRST_KEY);
    expect(resolveVaultWithdrawalKeptKey({ fingerprint })).toEqual({
      fingerprint,
      reused: true,
    });
  });

  it("adopts a kept recovery under its own fingerprint", () => {
    const customized = atomicFingerprint("5", 80);
    vaultWithdrawalIdempotencyKeyStore.claim(customized, () => FIRST_KEY);
    const recovery: VaultWithdrawalRecovery = {
      fingerprint: customized,
      floor: "4.8",
      shares: "5.01",
    };
    expect(resolveVaultWithdrawalKeptKey({ fingerprint: atomicFingerprint(), recovery })).toEqual({
      adoptedShares: "5.01",
      fingerprint: customized,
      reused: true,
    });
  });

  it("reports a spent recovery instead of minting over it", () => {
    // The recovered attempt's own answer arrived between the snapshot and
    // the confirm: the confirm was approved as a REPLAY, never a fresh
    // exit over it, so the resolution resolves to nothing sendable.
    vaultWithdrawalIdempotencyKeyStore.claim(legacyAtomicFingerprint, () => LEGACY_KEY);
    const recovery = recallVaultWithdrawalKeptAttempt(recoveryScope());
    vaultWithdrawalIdempotencyKeyStore.release(legacyAtomicFingerprint, LEGACY_KEY);
    expect(resolveVaultWithdrawalKeptKey({ fingerprint: atomicFingerprint(), recovery })).toEqual({
      fingerprint: legacyAtomicFingerprint,
      recoverySpent: true,
      reused: true,
    });
  });

  it("resolves a recovery with a LOST floor to nothing sendable", () => {
    // A replay cannot be exact without the minted floor, and a fresh key
    // over the live one is the double exit: no adoptedShares comes back.
    vaultWithdrawalIdempotencyKeyStore.claim(legacyAtomicFingerprint, () => LEGACY_KEY);
    const recovery = recallVaultWithdrawalKeptAttempt(recoveryScope());
    expect(resolveVaultWithdrawalKeptKey({ fingerprint: atomicFingerprint(), recovery })).toEqual({
      fingerprint: legacyAtomicFingerprint,
      reused: true,
    });
  });
});

describe("the memos", () => {
  it("replay a kept key's minted shares and floor verbatim, then forget them", () => {
    const fingerprint = atomicFingerprint();
    vaultWithdrawalIdempotencyKeyStore.claim(fingerprint, () => FIRST_KEY);
    rememberVaultWithdrawalFloor(fingerprint, "4.9");
    rememberVaultWithdrawalShares(fingerprint, "5");
    expect(recallVaultWithdrawalFloor(fingerprint)).toBe("4.9");
    expect(recallVaultWithdrawalShares(fingerprint)).toBe("5");

    vaultWithdrawalIdempotencyKeyStore.release(fingerprint, FIRST_KEY);
    forgetVaultWithdrawalFloor(fingerprint);
    forgetVaultWithdrawalShares(fingerprint);
    expect(recallVaultWithdrawalFloor(fingerprint)).toBeUndefined();
    expect(recallVaultWithdrawalShares(fingerprint)).toBeUndefined();
  });

  it("keep the values while the key is kept, even if forget is asked early", () => {
    const fingerprint = atomicFingerprint();
    vaultWithdrawalIdempotencyKeyStore.claim(fingerprint, () => FIRST_KEY);
    rememberVaultWithdrawalFloor(fingerprint, "4.9");
    rememberVaultWithdrawalShares(fingerprint, "5");

    forgetVaultWithdrawalFloor(fingerprint);
    forgetVaultWithdrawalShares(fingerprint);

    expect(recallVaultWithdrawalFloor(fingerprint)).toBe("4.9");
    expect(recallVaultWithdrawalShares(fingerprint)).toBe("5");
  });
});

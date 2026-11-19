// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  asyncWithdrawalRecoveryBody,
  type EarnVaultAsyncWithdrawalIntent,
  forgetAsyncWithdrawalShares,
  keptAsyncWithdrawalRetry,
  recallAsyncWithdrawalShares,
  recallLegacyAsyncWithdrawalKeptKey,
  rememberAsyncWithdrawalShares,
  resetAsyncWithdrawalTrackingStateForTests,
  resolveAsyncWithdrawalKeptKey,
  vaultAsyncWithdrawalIdempotencyKeyStore,
  vaultAsyncWithdrawalRequestFingerprint,
} from "./earn-vault-async-withdrawal-tracking";

const LEGACY_KEY = "00000000-0000-4000-8000-000000000000";
const FIRST_KEY = "00000000-0000-4000-8000-000000000001";

// The PREVIOUS build's identities: the DERIVED shares where this build keeps
// the typed dollar amount, no format tag.
const legacyQueueFingerprint = JSON.stringify(["project_1", "position_1", "5", "queue", 25, 360]);
const legacyOperatorFingerprint = JSON.stringify([
  "project_1",
  "position_1",
  "5",
  "operator_redemption",
]);
const legacyIntermediateFingerprint = JSON.stringify([
  "project_1",
  "position_1",
  "5",
  "operator_redemption",
  "intermediate",
]);

function queueIntent(amount = "5"): Extract<EarnVaultAsyncWithdrawalIntent, { amount: string }> {
  return {
    projectId: "project_1",
    positionId: "position_1",
    amount,
    route: { kind: "queue", discountBps: 25, deadlineSeconds: 360 },
  };
}

function operatorIntent(amount = "5"): EarnVaultAsyncWithdrawalIntent {
  return { ...queueIntent(amount), route: { kind: "operator_redemption" } };
}

function queueRecoveryScope() {
  return { projectId: "project_1", positionId: "position_1", routeKind: "queue" as const };
}

beforeEach(() => {
  sessionStorage.clear();
  resetAsyncWithdrawalTrackingStateForTests();
  let minted = 0;
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
    minted += 1;
    return `00000000-0000-4000-8000-00000000000${minted}` as `${string}-${string}-${string}-${string}-${string}`;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("vaultAsyncWithdrawalRequestFingerprint", () => {
  it("is stable for the same asynchronous-withdrawal intent", () => {
    // A semantically identical intent whose object keys are ordered
    // differently must not change the fingerprint, so a whole-object
    // serialization would fail here.
    const sameIntent = {
      positionId: "position_1",
      amount: "5",
      projectId: "project_1",
      route: {
        deadlineSeconds: 360,
        discountBps: 25,
        kind: "queue" as const,
      },
    } satisfies EarnVaultAsyncWithdrawalIntent;
    expect(vaultAsyncWithdrawalRequestFingerprint(sameIntent)).toBe(
      vaultAsyncWithdrawalRequestFingerprint(queueIntent())
    );
  });

  const changedIntents: ReadonlyArray<readonly [string, EarnVaultAsyncWithdrawalIntent]> = [
    ["project", { ...queueIntent(), projectId: "project_2" }],
    ["position", { ...queueIntent(), positionId: "position_2" }],
    ["typed amount", { ...queueIntent(), amount: "6" }],
    [
      "discount",
      { ...queueIntent(), route: { kind: "queue", discountBps: 26, deadlineSeconds: 360 } },
    ],
    [
      "deadline",
      { ...queueIntent(), route: { kind: "queue", discountBps: 25, deadlineSeconds: 361 } },
    ],
  ];

  it.each(changedIntents)("changes when the %s changes", (_label, changed) => {
    expect(vaultAsyncWithdrawalRequestFingerprint(changed)).not.toBe(
      vaultAsyncWithdrawalRequestFingerprint(queueIntent())
    );
  });

  it("keys the share routes on the TYPED dollar amount behind a format tag", () => {
    // The identity that replaced the derived shares: the shares the API
    // receives move with the live position polls, so keying on them drifted
    // under a kept key (see the fingerprint's comment). The tag leads so the
    // previous build's entries stay tellable apart.
    expect(vaultAsyncWithdrawalRequestFingerprint(queueIntent())).toBe(
      JSON.stringify(["async-typed-quantity-1", "project_1", "position_1", "5", "queue", 25, 360])
    );
    expect(vaultAsyncWithdrawalRequestFingerprint(operatorIntent())).toBe(
      JSON.stringify([
        "async-typed-quantity-1",
        "project_1",
        "position_1",
        "5",
        "operator_redemption",
      ])
    );
  });

  it("keeps the held-intermediate identity in the previous build's shape", () => {
    // The held intermediate IS the typed wire quantity — nothing derived,
    // nothing to drift — so renaming its identity would orphan kept keys for
    // no gain. This exact string is the compatibility guarantee.
    const held = vaultAsyncWithdrawalRequestFingerprint({
      projectId: "project_1",
      positionId: "position_1",
      intermediateAmount: "5",
      route: { kind: "operator_redemption" },
    });
    expect(held).toBe(legacyIntermediateFingerprint);
    expect(held).not.toBe(vaultAsyncWithdrawalRequestFingerprint(queueIntent()));
  });

  it("separates operator redemption from a solver queue without queue-only fields", () => {
    expect(vaultAsyncWithdrawalRequestFingerprint(operatorIntent())).not.toBe(
      vaultAsyncWithdrawalRequestFingerprint(queueIntent())
    );
  });
});

describe("recallLegacyAsyncWithdrawalKeptKey", () => {
  it("adopts the previous build's unresolved queue attempt with its own terms", () => {
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(legacyQueueFingerprint, () => LEGACY_KEY);
    expect(recallLegacyAsyncWithdrawalKeptKey(queueRecoveryScope())).toEqual({
      fingerprint: legacyQueueFingerprint,
      route: { kind: "queue", discountBps: 25, deadlineSeconds: 360 },
      shares: "5",
    });
  });

  it("adopts an operator-redemption attempt for that route only", () => {
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(legacyOperatorFingerprint, () => LEGACY_KEY);
    expect(
      recallLegacyAsyncWithdrawalKeptKey({
        projectId: "project_1",
        positionId: "position_1",
        routeKind: "operator_redemption",
      })
    ).toEqual({
      fingerprint: legacyOperatorFingerprint,
      route: { kind: "operator_redemption" },
      shares: "5",
    });
    expect(recallLegacyAsyncWithdrawalKeptKey(queueRecoveryScope())).toBeUndefined();
  });

  it("never adopts a held-intermediate entry", () => {
    // Its keys keep the previous build's identity and stay reachable through
    // `has` — adopting one from a shares submission would replay the wrong
    // request.
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(legacyIntermediateFingerprint, () => LEGACY_KEY);
    expect(
      recallLegacyAsyncWithdrawalKeptKey({
        projectId: "project_1",
        positionId: "position_1",
        routeKind: "operator_redemption",
      })
    ).toBeUndefined();
  });

  it("refuses this build's own tagged entries", () => {
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(
      vaultAsyncWithdrawalRequestFingerprint(queueIntent()),
      () => FIRST_KEY
    );
    expect(recallLegacyAsyncWithdrawalKeptKey(queueRecoveryScope())).toBeUndefined();
  });

  it("matches the project and position, and refuses entries of other scopes", () => {
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(legacyQueueFingerprint, () => LEGACY_KEY);
    expect(
      recallLegacyAsyncWithdrawalKeptKey({ ...queueRecoveryScope(), projectId: "project_2" })
    ).toBeUndefined();
    expect(
      recallLegacyAsyncWithdrawalKeptKey({ ...queueRecoveryScope(), positionId: "position_2" })
    ).toBeUndefined();
  });
});

describe("resolveAsyncWithdrawalKeptKey", () => {
  it("mints fresh for an unknown fingerprint and reports a kept key's reuse", () => {
    const fingerprint = vaultAsyncWithdrawalRequestFingerprint(queueIntent());
    expect(resolveAsyncWithdrawalKeptKey({ fingerprint })).toEqual({ fingerprint, reused: false });
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(fingerprint, () => FIRST_KEY);
    expect(resolveAsyncWithdrawalKeptKey({ fingerprint })).toEqual({ fingerprint, reused: true });
  });

  it("adopts a kept legacy recovery under the legacy fingerprint", () => {
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(legacyQueueFingerprint, () => LEGACY_KEY);
    const recovery = recallLegacyAsyncWithdrawalKeptKey(queueRecoveryScope());
    expect(
      resolveAsyncWithdrawalKeptKey({
        fingerprint: vaultAsyncWithdrawalRequestFingerprint(queueIntent()),
        recovery,
      })
    ).toEqual({ adopted: recovery, fingerprint: legacyQueueFingerprint, reused: true });
  });

  it("reports a spent recovery instead of minting over it", () => {
    // The recovered attempt's own answer arrived between the snapshot and
    // the confirm: the confirm was approved as a REPLAY, never a fresh
    // escrow over it, so the resolution resolves to nothing sendable.
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(legacyQueueFingerprint, () => LEGACY_KEY);
    const recovery = recallLegacyAsyncWithdrawalKeptKey(queueRecoveryScope());
    vaultAsyncWithdrawalIdempotencyKeyStore.release(legacyQueueFingerprint, LEGACY_KEY);
    expect(
      resolveAsyncWithdrawalKeptKey({
        fingerprint: vaultAsyncWithdrawalRequestFingerprint(queueIntent()),
        recovery,
      })
    ).toEqual({ fingerprint: legacyQueueFingerprint, recoverySpent: true, reused: true });
  });
});

describe("asyncWithdrawalRecoveryBody", () => {
  it("rebuilds a queue attempt's own body from the legacy identity", () => {
    expect(
      asyncWithdrawalRecoveryBody(
        {
          fingerprint: legacyQueueFingerprint,
          route: { kind: "queue", discountBps: 25, deadlineSeconds: 360 },
          shares: "5",
        },
        "position_1"
      )
    ).toEqual({ deadlineSeconds: 360, discountBps: 25, positionId: "position_1", shares: "5" });
  });

  it("rebuilds an operator attempt's own body", () => {
    expect(
      asyncWithdrawalRecoveryBody(
        {
          fingerprint: legacyOperatorFingerprint,
          route: { kind: "operator_redemption" },
          shares: "5",
        },
        "position_1"
      )
    ).toEqual({
      mechanism: "operatorRedemption",
      positionId: "position_1",
      shares: "5",
    });
  });
});

describe("the shares memo", () => {
  it("replays a kept key's minted shares verbatim and forgets them once retired", () => {
    const fingerprint = vaultAsyncWithdrawalRequestFingerprint(queueIntent());
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(fingerprint, () => FIRST_KEY);
    // The live derivation has moved on; the MINTED intent is what the API's
    // fingerprint pins, so it is remembered and replayed instead.
    rememberAsyncWithdrawalShares(fingerprint, "5");
    expect(recallAsyncWithdrawalShares(fingerprint)).toBe("5");
    expect(keptAsyncWithdrawalRetry(fingerprint)).toEqual({ shares: "5" });

    vaultAsyncWithdrawalIdempotencyKeyStore.release(fingerprint, FIRST_KEY);
    forgetAsyncWithdrawalShares(fingerprint);
    expect(recallAsyncWithdrawalShares(fingerprint)).toBeUndefined();
  });

  it("keeps the shares while the key is kept, even if forget is asked early", () => {
    const fingerprint = vaultAsyncWithdrawalRequestFingerprint(queueIntent());
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(fingerprint, () => FIRST_KEY);
    rememberAsyncWithdrawalShares(fingerprint, "5");

    forgetAsyncWithdrawalShares(fingerprint);

    expect(recallAsyncWithdrawalShares(fingerprint)).toBe("5");
  });

  it("reports a lost memo as a kept attempt with nothing sendable", () => {
    const fingerprint = vaultAsyncWithdrawalRequestFingerprint(queueIntent());
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(fingerprint, () => FIRST_KEY);

    // No memo entry: the retry cannot replay the minted intent exactly, so
    // the submit must stop rather than pair the live key with a fresh guess.
    expect(keptAsyncWithdrawalRetry(fingerprint)).toEqual({ shares: undefined });
  });

  it("answers undefined when no key is kept", () => {
    expect(
      keptAsyncWithdrawalRetry(vaultAsyncWithdrawalRequestFingerprint(queueIntent()))
    ).toBeUndefined();
    expect(keptAsyncWithdrawalRetry(undefined)).toBeUndefined();
  });
});

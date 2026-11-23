// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  asyncWithdrawalRecoveryBody,
  type EarnVaultAsyncWithdrawalIntent,
  forgetAsyncWithdrawalShares,
  keptAsyncWithdrawalRetry,
  recallAsyncWithdrawalKeptAttempt,
  recallAsyncWithdrawalShares,
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
    // SAFETY: the stub keeps randomUUID's hyphenated 8-4-4-4-12 shape — a
    // fixed hex prefix with the counter in the final group — so the literal
    // satisfies the UUID template type it is asserted to.
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

describe("recallAsyncWithdrawalKeptAttempt", () => {
  it("adopts the previous build's unresolved queue attempt with its own terms", () => {
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(legacyQueueFingerprint, () => LEGACY_KEY);
    expect(recallAsyncWithdrawalKeptAttempt(queueRecoveryScope())).toEqual({
      fingerprint: legacyQueueFingerprint,
      route: { kind: "queue", discountBps: 25, deadlineSeconds: 360 },
      shares: "5",
    });
  });

  it("adopts an operator-redemption attempt for that route only", () => {
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(legacyOperatorFingerprint, () => LEGACY_KEY);
    expect(
      recallAsyncWithdrawalKeptAttempt({
        projectId: "project_1",
        positionId: "position_1",
        routeKind: "operator_redemption",
      })
    ).toEqual({
      fingerprint: legacyOperatorFingerprint,
      route: { kind: "operator_redemption" },
      shares: "5",
    });
    expect(recallAsyncWithdrawalKeptAttempt(queueRecoveryScope())).toBeUndefined();
  });

  it("never adopts a held-intermediate entry", () => {
    // Its keys keep the previous build's identity and stay reachable through
    // `has` — adopting one from a shares submission would replay the wrong
    // request.
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(legacyIntermediateFingerprint, () => LEGACY_KEY);
    expect(
      recallAsyncWithdrawalKeptAttempt({
        projectId: "project_1",
        positionId: "position_1",
        routeKind: "operator_redemption",
      })
    ).toBeUndefined();
  });

  it("adopts this build's kept entry minted under customized queue terms", () => {
    // The reload stranding the recovery exists for: the queued form re-seeds
    // its discount and deadline to the provider's minimums at mount, so the
    // kept key under the CUSTOMIZED terms is reachable through no fingerprint
    // the form can recompute. The scan adopts it; the identity carries the
    // terms the replay must restore, and the memo carries the shares.
    const customized = vaultAsyncWithdrawalRequestFingerprint({
      ...queueIntent(),
      route: { kind: "queue", discountBps: 120, deadlineSeconds: 3600 },
    });
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(customized, () => FIRST_KEY);
    rememberAsyncWithdrawalShares(customized, "7.5");
    expect(recallAsyncWithdrawalKeptAttempt(queueRecoveryScope())).toEqual({
      fingerprint: customized,
      route: { kind: "queue", discountBps: 120, deadlineSeconds: 3600 },
      shares: "7.5",
    });
  });

  it("adopts this build's kept entry with a LOST shares memo as nothing sendable", () => {
    // Another tab (or a refused store) holds no shares memo for the kept key:
    // the adoption must still surface — a skipped entry would invite the
    // mint-over — and the undefined shares stop the submit instead.
    const customized = vaultAsyncWithdrawalRequestFingerprint(queueIntent("9"));
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(customized, () => FIRST_KEY);
    expect(recallAsyncWithdrawalKeptAttempt(queueRecoveryScope())).toEqual({
      fingerprint: customized,
      route: { kind: "queue", discountBps: 25, deadlineSeconds: 360 },
      shares: undefined,
    });
  });

  it("adopts this build's kept operator-redemption entry", () => {
    const customized = vaultAsyncWithdrawalRequestFingerprint(operatorIntent("4"));
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(customized, () => FIRST_KEY);
    rememberAsyncWithdrawalShares(customized, "12");
    expect(
      recallAsyncWithdrawalKeptAttempt({
        projectId: "project_1",
        positionId: "position_1",
        routeKind: "operator_redemption",
      })
    ).toEqual({
      fingerprint: customized,
      route: { kind: "operator_redemption" },
      shares: "12",
    });
  });

  it("adopts the OLDEST kept attempt first across both shapes", () => {
    // Claim times decide the order, not the shapes: the scan answers the
    // first attempt first, whichever build wrote it.
    const clock = vi.spyOn(Date, "now");
    let nowMs = 1_000_000;
    clock.mockImplementation(() => (nowMs += 1));
    const own = vaultAsyncWithdrawalRequestFingerprint(queueIntent());
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(own, () => FIRST_KEY);
    nowMs += 10_000;
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(legacyQueueFingerprint, () => LEGACY_KEY);
    clock.mockRestore();
    expect(recallAsyncWithdrawalKeptAttempt(queueRecoveryScope())?.fingerprint).toBe(own);
    // And once the oldest is answered, the re-scan walks to the next one.
    vaultAsyncWithdrawalIdempotencyKeyStore.release(own, FIRST_KEY);
    expect(recallAsyncWithdrawalKeptAttempt(queueRecoveryScope())?.fingerprint).toBe(
      legacyQueueFingerprint
    );
  });

  it("matches the project and position, and refuses entries of other scopes", () => {
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(legacyQueueFingerprint, () => LEGACY_KEY);
    const own = vaultAsyncWithdrawalRequestFingerprint(queueIntent());
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(own, () => FIRST_KEY);
    expect(
      recallAsyncWithdrawalKeptAttempt({ ...queueRecoveryScope(), projectId: "project_2" })
    ).toBeUndefined();
    expect(
      recallAsyncWithdrawalKeptAttempt({ ...queueRecoveryScope(), positionId: "position_2" })
    ).toBeUndefined();
  });
});

describe("resolveAsyncWithdrawalKeptKey", () => {
  it("mints fresh for an unknown fingerprint and reports a kept key's reuse", () => {
    const fingerprint = vaultAsyncWithdrawalRequestFingerprint(queueIntent());
    expect(resolveAsyncWithdrawalKeptKey({ fingerprint })).toEqual({
      fingerprint,
      kind: "fresh",
      reused: false,
    });
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(fingerprint, () => FIRST_KEY);
    expect(resolveAsyncWithdrawalKeptKey({ fingerprint })).toEqual({
      fingerprint,
      kind: "kept",
      reused: true,
    });
  });

  it("adopts a kept legacy recovery under the legacy fingerprint", () => {
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(legacyQueueFingerprint, () => LEGACY_KEY);
    const recovery = recallAsyncWithdrawalKeptAttempt(queueRecoveryScope());
    expect(
      resolveAsyncWithdrawalKeptKey({
        fingerprint: vaultAsyncWithdrawalRequestFingerprint(queueIntent()),
        recovery,
      })
    ).toEqual({
      adopted: recovery,
      fingerprint: legacyQueueFingerprint,
      kind: "adopted",
      reused: true,
    });
  });

  it("reports a spent recovery instead of minting over it", () => {
    // The recovered attempt's own answer arrived between the snapshot and
    // the confirm: the confirm was approved as a REPLAY, never a fresh
    // escrow over it, so the resolution resolves to nothing sendable.
    vaultAsyncWithdrawalIdempotencyKeyStore.claim(legacyQueueFingerprint, () => LEGACY_KEY);
    const recovery = recallAsyncWithdrawalKeptAttempt(queueRecoveryScope());
    vaultAsyncWithdrawalIdempotencyKeyStore.release(legacyQueueFingerprint, LEGACY_KEY);
    expect(
      resolveAsyncWithdrawalKeptKey({
        fingerprint: vaultAsyncWithdrawalRequestFingerprint(queueIntent()),
        recovery,
      })
    ).toEqual({
      fingerprint: legacyQueueFingerprint,
      kind: "spent",
      recoverySpent: true,
      reused: true,
    });
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

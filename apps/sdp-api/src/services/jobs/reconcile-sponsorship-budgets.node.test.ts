import { address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import type { SponsorshipReconciliationReservation } from "@/db/repositories/sponsorship-budget.repository";
import type { Env } from "@/types/env";
import { sponsorshipProviderConfigFingerprint } from "../sponsorship-budget.service";
import {
  KORA_CONFIG_UNAVAILABLE_BREAKER_REASON,
  reconcileSponsorshipBudgets,
} from "./reconcile-sponsorship-budgets";

const logEvent = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/money-path-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/runtime/money-path-events")>()),
  logEvent,
}));

const ZERO_OUTFLOW_FEE_PAYER_POLICY = {
  system: {
    allow_transfer: false,
    allow_assign: false,
    allow_create_account: false,
    allow_allocate: false,
    nonce: {
      allow_initialize: false,
      allow_advance: false,
      allow_authorize: false,
      allow_withdraw: false,
    },
  },
  spl_token: {
    allow_transfer: false,
    allow_burn: false,
    allow_close_account: false,
    allow_approve: false,
    allow_revoke: false,
    allow_set_authority: false,
    allow_mint_to: false,
    allow_initialize_mint: false,
    allow_initialize_account: false,
    allow_initialize_multisig: false,
    allow_freeze_account: false,
    allow_thaw_account: false,
  },
  token_2022: {
    allow_transfer: false,
    allow_burn: false,
    allow_close_account: false,
    allow_approve: false,
    allow_revoke: false,
    allow_set_authority: false,
    allow_mint_to: false,
    allow_initialize_mint: false,
    allow_initialize_account: false,
    allow_initialize_multisig: false,
    allow_freeze_account: false,
    allow_thaw_account: false,
  },
} as const;

const PROVIDER_CONFIGURATION = {
  signerAddress: address("4YhMUz8xDgHMPAevvfMpnJX9TJmw9DTNDA1sNWPRZG9q"),
  maxAllowedLamports: 10n,
  feePayerMayTransferLamports: false,
  feePayerPolicy: ZERO_OUTFLOW_FEE_PAYER_POLICY,
};

const TEST_SIGNATURE =
  "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy";
const TEST_BLOCKHASH = "29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2";

function reservation(
  overrides: Partial<SponsorshipReconciliationReservation> = {}
): SponsorshipReconciliationReservation {
  return {
    id: "reservation_1",
    status: "submitted",
    signature: TEST_SIGNATURE,
    signedTransaction: null,
    reservedLamports: 5,
    actualLamports: null,
    attempt: 1,
    network: "devnet",
    organizationId: "org_1",
    projectId: "project_1",
    feePayer: PROVIDER_CONFIGURATION.signerAddress,
    providerConfigFingerprint: sponsorshipProviderConfigFingerprint(PROVIDER_CONFIGURATION),
    recentBlockhash: TEST_BLOCKHASH,
    hourBucket: "2026-08-03T10:00:00.000Z",
    dayBucket: "2026-08-03T00:00:00.000Z",
    missCount: 0,
    updatedAt: "2026-08-03T10:00:00.000Z",
    redisSettledAt: null,
    ...overrides,
  };
}

function harness(candidate: SponsorshipReconciliationReservation) {
  const breakerPolicy = {
    id: "global",
    network: "devnet" as const,
    scopeType: "global" as const,
    scopeId: null,
    enabled: false,
    perTransactionLamports: 10,
    hourlyLamports: 100,
    dailyLamports: 100,
    version: 2,
    updatedBy: "system",
    updateReason: "breaker",
    updatedAt: "2026-08-03T10:00:00.000Z",
  };
  const repository = {
    listReconciliationCandidates: vi.fn().mockResolvedValue([candidate]),
    recordReconciliationMiss: vi.fn().mockResolvedValue(true),
    settleReservation: vi.fn().mockResolvedValue(true),
    markChargedUnknown: vi.fn().mockResolvedValue(true),
    getReservation: vi.fn().mockResolvedValue(null),
    getGlobalPolicy: vi.fn().mockResolvedValue({ ...breakerPolicy, enabled: true }),
    tripGlobalBreaker: vi.fn().mockResolvedValue(breakerPolicy),
    resumeGlobalBreaker: vi.fn().mockResolvedValue(null),
    markRedisSettled: vi.fn().mockResolvedValue(true),
  };
  const budgetRedis = {
    settle: vi.fn().mockResolvedValue(0),
    syncPolicy: vi.fn().mockResolvedValue(undefined),
  };
  const getTransaction = vi.fn().mockResolvedValue({
    slot: 1n,
    err: null,
    fee: 1n,
    preBalances: [10n],
    postBalances: [7n],
    instructions: [],
  });
  const isBlockhashValid = vi.fn().mockResolvedValue(true);
  const run = () =>
    reconcileSponsorshipBudgets({} as Env, {
      repository,
      budgetRedis,
      getTransaction,
      isBlockhashValid,
      getProviderConfiguration: vi.fn().mockResolvedValue(PROVIDER_CONFIGURATION),
      now: () => new Date("2026-08-03T10:05:00.000Z"),
      sleep: vi.fn().mockResolvedValue(undefined),
    });
  return { repository, budgetRedis, getTransaction, isBlockhashValid, run };
}

describe("reconcileSponsorshipBudgets", () => {
  it("retries terminal rows whose durable Redis settlement is incomplete", async () => {
    const candidate = reservation({
      status: "committed",
      actualLamports: 3,
      redisSettledAt: null,
    });
    const { repository, budgetRedis, run } = harness(candidate);
    budgetRedis.settle.mockRejectedValueOnce(new Error("redis offline"));
    await expect(run()).rejects.toThrow("failed reconciliation");
    expect(repository.markRedisSettled).not.toHaveBeenCalled();
    await expect(run()).resolves.toBeUndefined();
    expect(budgetRedis.settle).toHaveBeenCalledTimes(2);
    expect(repository.markRedisSettled).toHaveBeenCalledOnce();
  });

  it("finishes an expired Redis reservation without tripping the breaker", async () => {
    const candidate = reservation({
      status: "committed",
      actualLamports: 3,
      redisSettledAt: null,
    });
    const { repository, budgetRedis, run } = harness(candidate);
    budgetRedis.settle.mockResolvedValueOnce(-2);

    await expect(run()).resolves.toBeUndefined();

    expect(budgetRedis.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "reservation_1",
        attempt: 1,
        detectMissingReservation: true,
      })
    );
    expect(repository.markRedisSettled).toHaveBeenCalledWith("reservation_1", 1);
    expect(repository.tripGlobalBreaker).not.toHaveBeenCalled();
  });

  it("charges actual fee-payer balance delta and trips the breaker on under-reservation", async () => {
    const { repository, budgetRedis, getTransaction, run } = harness(reservation());
    getTransaction.mockResolvedValueOnce({
      slot: 1n,
      err: null,
      fee: 1n,
      preBalances: [20n],
      postBalances: [10n],
      instructions: [],
    });
    await run();
    expect(repository.tripGlobalBreaker).toHaveBeenCalledWith(
      "devnet",
      expect.stringContaining("exceeded reservation"),
      {}
    );
    expect(repository.settleReservation).toHaveBeenCalledWith(
      "reservation_1",
      1,
      "committed",
      10,
      undefined
    );
    expect(budgetRedis.settle).toHaveBeenCalledWith(
      expect.objectContaining({ actualLamports: 10 })
    );
  });

  it("charges failed on-chain transactions by observed fee-payer balance delta", async () => {
    const { repository, getTransaction, run } = harness(reservation({ reservedLamports: 10 }));
    getTransaction.mockResolvedValueOnce({
      slot: 1n,
      err: { InstructionError: [0, "Custom"] },
      fee: 5n,
      preBalances: [20n],
      postBalances: [15n],
      instructions: [],
    });
    await run();
    expect(repository.settleReservation).toHaveBeenCalledWith(
      "reservation_1",
      1,
      "committed",
      5,
      undefined
    );
  });

  it("retains the full reservation when RPC state is uncertain", async () => {
    const { repository, budgetRedis, getTransaction, run } = harness(reservation());
    getTransaction.mockRejectedValueOnce(new Error("RPC timeout"));
    await expect(run()).rejects.toThrow("failed reconciliation");
    expect(repository.settleReservation).not.toHaveBeenCalled();
    expect(budgetRedis.settle).not.toHaveBeenCalled();
  });

  it("charges signed transactions as unknown after two expired-blockhash misses", async () => {
    const first = harness(reservation({ status: "signed", missCount: 0 }));
    first.getTransaction.mockResolvedValueOnce(null);
    first.isBlockhashValid.mockResolvedValueOnce(false);
    await first.run();
    expect(first.repository.listReconciliationCandidates).toHaveBeenCalledWith(
      "devnet",
      "2026-08-03T10:03:00.000Z",
      250
    );
    expect(first.repository.recordReconciliationMiss).toHaveBeenCalledWith("reservation_1", 1, 0);
    expect(first.repository.markChargedUnknown).not.toHaveBeenCalled();

    const second = harness(reservation({ status: "signed", missCount: 1 }));
    second.getTransaction.mockResolvedValueOnce(null);
    second.isBlockhashValid.mockResolvedValueOnce(false);
    await second.run();
    expect(second.repository.markChargedUnknown).toHaveBeenCalledWith(
      "reservation_1",
      1,
      expect.stringContaining("two reconciliation passes")
    );
    expect(second.repository.settleReservation).not.toHaveBeenCalled();
    expect(second.budgetRedis.settle).not.toHaveBeenCalled();
  });

  it("retains submitted spend as charged unknown after two expired-blockhash misses", async () => {
    const first = harness(reservation({ status: "submitted", missCount: 0 }));
    first.getTransaction.mockResolvedValueOnce(null);
    first.isBlockhashValid.mockResolvedValueOnce(false);
    await first.run();
    expect(first.repository.recordReconciliationMiss).toHaveBeenCalledWith("reservation_1", 1, 0);
    expect(first.repository.markChargedUnknown).not.toHaveBeenCalled();

    const second = harness(reservation({ status: "submitted", missCount: 1 }));
    second.getTransaction.mockResolvedValueOnce(null);
    second.isBlockhashValid.mockResolvedValueOnce(false);
    await second.run();
    expect(second.repository.markChargedUnknown).toHaveBeenCalledWith(
      "reservation_1",
      1,
      expect.stringContaining("Signature absent")
    );
    expect(second.repository.settleReservation).not.toHaveBeenCalled();
    expect(second.budgetRedis.settle).not.toHaveBeenCalled();
    expect(second.repository.markRedisSettled).not.toHaveBeenCalled();
  });

  it("charges stale signature-less provider outcomes as unknown", async () => {
    const { repository, getTransaction, run } = harness(
      reservation({ status: "reserved", signature: null })
    );
    await run();
    expect(repository.markChargedUnknown).toHaveBeenCalledOnce();
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it("does not let a stale reconciliation snapshot settle a newer attempt in Redis", async () => {
    const { repository, budgetRedis, run } = harness(reservation({ attempt: 1 }));
    repository.settleReservation.mockResolvedValueOnce(false);

    await expect(run()).resolves.toBeUndefined();

    expect(repository.settleReservation).toHaveBeenCalledWith(
      "reservation_1",
      1,
      "committed",
      3,
      undefined
    );
    expect(budgetRedis.settle).not.toHaveBeenCalled();
    expect(repository.markRedisSettled).not.toHaveBeenCalled();
  });

  it.each([{ feePayer: "changed_signer" }, { providerConfigFingerprint: "changed_configuration" }])(
    "trips the breaker when Kora security identity drifts ($feePayer)",
    async (override) => {
      const { repository, budgetRedis, getTransaction, run } = harness(reservation(override));
      await expect(run()).rejects.toThrow("failed reconciliation");
      expect(repository.tripGlobalBreaker).toHaveBeenCalledWith(
        "devnet",
        expect.stringContaining("configuration changed"),
        {}
      );
      expect(budgetRedis.syncPolicy).toHaveBeenCalledOnce();
      expect(getTransaction).not.toHaveBeenCalled();
    }
  );

  it("trips the breaker only after exhausting config read retries", async () => {
    const candidate = reservation();
    const { repository, budgetRedis, getTransaction } = harness(candidate);
    const getProviderConfiguration = vi.fn().mockRejectedValue(new Error("Kora unavailable"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      reconcileSponsorshipBudgets({ SOLANA_NETWORK: "devnet" } as Env, {
        repository,
        budgetRedis,
        getTransaction,
        isBlockhashValid: vi.fn(),
        getProviderConfiguration,
        now: () => new Date("2026-08-03T10:05:00.000Z"),
        sleep,
      })
    ).rejects.toThrow("configuration is unavailable");
    expect(getProviderConfiguration).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(repository.tripGlobalBreaker).toHaveBeenCalledWith(
      "devnet",
      expect.stringContaining("unavailable"),
      { recoverable: true }
    );
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it("does not trip the breaker when a config read succeeds on retry", async () => {
    const candidate = reservation();
    const { repository, budgetRedis, getTransaction, isBlockhashValid } = harness(candidate);
    const getProviderConfiguration = vi
      .fn()
      .mockRejectedValueOnce(new Error("Kora unavailable"))
      .mockResolvedValue(PROVIDER_CONFIGURATION);
    await expect(
      reconcileSponsorshipBudgets({ SOLANA_NETWORK: "devnet" } as Env, {
        repository,
        budgetRedis,
        getTransaction,
        isBlockhashValid,
        getProviderConfiguration,
        now: () => new Date("2026-08-03T10:05:00.000Z"),
        sleep: vi.fn().mockResolvedValue(undefined),
      })
    ).resolves.toBeUndefined();
    expect(getProviderConfiguration).toHaveBeenCalledTimes(2);
    expect(repository.tripGlobalBreaker).not.toHaveBeenCalled();
  });

  it("does not trip the breaker when a concurrent pass already recorded the ambiguous charge", async () => {
    const { repository, budgetRedis, run } = harness(reservation({ signature: null, attempt: 1 }));
    repository.markChargedUnknown.mockResolvedValue(false);
    repository.getReservation.mockResolvedValue({
      id: "reservation_1",
      status: "charged_unknown",
      signature: null,
      signedTransaction: null,
      reservedLamports: 3,
      actualLamports: null,
      attempt: 1,
    });

    await expect(run()).resolves.toBeUndefined();

    expect(repository.getReservation).toHaveBeenCalledWith("reservation_1");
    expect(repository.tripGlobalBreaker).not.toHaveBeenCalled();
    expect(budgetRedis.syncPolicy).not.toHaveBeenCalled();
  });

  it("trips the breaker when the ambiguous charge is lost with no concurrent terminal transition", async () => {
    const { repository, budgetRedis, run } = harness(reservation({ signature: null, attempt: 1 }));
    repository.markChargedUnknown.mockResolvedValue(false);
    repository.getReservation.mockResolvedValue(null);

    await expect(run()).rejects.toThrow("failed reconciliation");

    expect(repository.getReservation).toHaveBeenCalledWith("reservation_1");
    expect(repository.tripGlobalBreaker).toHaveBeenCalledWith(
      "devnet",
      expect.stringContaining("lost its durable transition"),
      {}
    );
    expect(budgetRedis.syncPolicy).toHaveBeenCalledOnce();
    expect(logEvent).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        event: "sdp_api_sponsorship_breaker_tripped",
        network: "devnet",
        source: "reconciliation",
      })
    );
  });

  it("reports a tick that found nothing, so silence is distinguishable from a dead job", async () => {
    const { repository, budgetRedis, run } = harness(reservation());
    logEvent.mockClear();
    repository.listReconciliationCandidates.mockResolvedValue([]);

    await expect(run()).resolves.toBeUndefined();

    expect(logEvent).toHaveBeenCalledWith(
      "info",
      expect.objectContaining({
        event: "sdp_api_sponsorship_reconciliation_tick",
        network: "devnet",
        candidates: 0,
        failed: 0,
      })
    );
    expect(budgetRedis.settle).not.toHaveBeenCalled();
  });

  it("reports the breaker even when the Redis policy sync fails afterwards", async () => {
    const { repository, budgetRedis, getTransaction, run } = harness(reservation());
    logEvent.mockClear();
    budgetRedis.syncPolicy.mockRejectedValue(new Error("redis offline"));
    getTransaction.mockResolvedValueOnce({
      slot: 1n,
      err: null,
      fee: 1n,
      preBalances: [20n],
      postBalances: [10n],
      instructions: [],
    });

    await expect(run()).rejects.toThrow("failed reconciliation");

    expect(repository.tripGlobalBreaker).toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        event: "sdp_api_sponsorship_breaker_tripped",
        source: "reconciliation",
      })
    );
  });

  function trippedPolicy(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "global",
      network: "devnet" as const,
      scopeType: "global" as const,
      scopeId: null,
      enabled: false,
      perTransactionLamports: 10,
      hourlyLamports: 100,
      dailyLamports: 100,
      version: 2,
      updatedBy: "system:sponsorship-breaker",
      updateReason: KORA_CONFIG_UNAVAILABLE_BREAKER_REASON,
      updatedAt: "2026-08-03T10:00:00.000Z",
      ...overrides,
    };
  }

  it("auto-resumes a config-unavailability breaker trip once the config is readable", async () => {
    const { repository, budgetRedis, run } = harness(reservation());
    repository.listReconciliationCandidates.mockResolvedValue([]);
    repository.getGlobalPolicy.mockResolvedValue(trippedPolicy());
    const resumedPolicy = trippedPolicy({ enabled: true, version: 3 });
    repository.resumeGlobalBreaker.mockResolvedValue(resumedPolicy);

    await expect(run()).resolves.toBeUndefined();

    expect(repository.resumeGlobalBreaker).toHaveBeenCalledWith(
      "devnet",
      KORA_CONFIG_UNAVAILABLE_BREAKER_REASON,
      expect.stringContaining("readable again")
    );
    expect(budgetRedis.syncPolicy).toHaveBeenCalledWith(resumedPolicy);
  });

  it("does not auto-resume a policy disabled by an operator", async () => {
    const { repository, run } = harness(reservation());
    repository.listReconciliationCandidates.mockResolvedValue([]);
    repository.getGlobalPolicy.mockResolvedValue(
      trippedPolicy({ updatedBy: "operator:oncall", updateReason: "manual kill" })
    );

    await expect(run()).resolves.toBeUndefined();

    expect(repository.resumeGlobalBreaker).not.toHaveBeenCalled();
  });

  it("does not auto-resume an integrity breaker trip", async () => {
    const { repository, run } = harness(reservation());
    repository.listReconciliationCandidates.mockResolvedValue([]);
    repository.getGlobalPolicy.mockResolvedValue(
      trippedPolicy({ updateReason: "Actual sponsorship spend 9 exceeded reservation 5" })
    );

    await expect(run()).resolves.toBeUndefined();

    expect(repository.resumeGlobalBreaker).not.toHaveBeenCalled();
  });

  it("keeps the breaker down without re-tripping when the recovery probe fails", async () => {
    const { repository, budgetRedis, getTransaction } = harness(reservation());
    repository.listReconciliationCandidates.mockResolvedValue([]);
    repository.getGlobalPolicy.mockResolvedValue(trippedPolicy());

    await expect(
      reconcileSponsorshipBudgets({ SOLANA_NETWORK: "devnet" } as Env, {
        repository,
        budgetRedis,
        getTransaction,
        isBlockhashValid: vi.fn(),
        getProviderConfiguration: vi.fn().mockRejectedValue(new Error("Kora unavailable")),
        now: () => new Date("2026-08-03T10:05:00.000Z"),
        sleep: vi.fn().mockResolvedValue(undefined),
      })
    ).rejects.toThrow("configuration is unavailable");

    expect(repository.tripGlobalBreaker).not.toHaveBeenCalled();
    expect(repository.resumeGlobalBreaker).not.toHaveBeenCalled();
  });

  it("resumes the breaker and reconciles candidates in the same pass", async () => {
    const { repository, run } = harness(
      reservation({ status: "committed", actualLamports: 3, redisSettledAt: null })
    );
    repository.getGlobalPolicy.mockResolvedValue(trippedPolicy());
    const resumedPolicy = trippedPolicy({ enabled: true, version: 3 });
    repository.resumeGlobalBreaker.mockResolvedValue(resumedPolicy);

    await expect(run()).resolves.toBeUndefined();

    expect(repository.resumeGlobalBreaker).toHaveBeenCalledOnce();
    expect(repository.markRedisSettled).toHaveBeenCalled();
  });
});

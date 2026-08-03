import { describe, expect, it, vi } from "vitest";
import type { SponsorshipReconciliationReservation } from "@/db/repositories/sponsorship-budget.repository";
import type { Env } from "@/types/env";
import { sponsorshipProviderConfigFingerprint } from "../sponsorship-budget.service";
import { reconcileSponsorshipBudgets } from "./reconcile-sponsorship-budgets";

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
  signerAddress: "fee_payer_1" as never,
  maxAllowedLamports: 10n,
  feePayerMayTransferLamports: false,
  feePayerPolicy: ZERO_OUTFLOW_FEE_PAYER_POLICY,
};

function reservation(
  overrides: Partial<SponsorshipReconciliationReservation> = {}
): SponsorshipReconciliationReservation {
  return {
    id: "reservation_1",
    status: "submitted",
    signature: "signature_1",
    signedTransaction: null,
    reservedLamports: 5,
    actualLamports: null,
    attempt: 1,
    network: "devnet",
    organizationId: "org_1",
    projectId: "project_1",
    feePayer: PROVIDER_CONFIGURATION.signerAddress,
    providerConfigFingerprint: sponsorshipProviderConfigFingerprint(PROVIDER_CONFIGURATION),
    recentBlockhash: "blockhash_1",
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
    tripGlobalBreaker: vi.fn().mockResolvedValue(breakerPolicy),
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
      expect.stringContaining("exceeded reservation")
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

  it("releases only signed transactions after two expired-blockhash misses", async () => {
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
    expect(first.repository.settleReservation).not.toHaveBeenCalled();

    const second = harness(reservation({ status: "signed", missCount: 1 }));
    second.getTransaction.mockResolvedValueOnce(null);
    second.isBlockhashValid.mockResolvedValueOnce(false);
    await second.run();
    expect(second.repository.settleReservation).toHaveBeenCalledWith(
      "reservation_1",
      1,
      "released",
      0,
      expect.stringContaining("two reconciliation passes")
    );
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
      expect.stringContaining("Submitted signature absent")
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

  it.each([
    { feePayer: "changed_signer" },
    { providerConfigFingerprint: "changed_configuration" },
  ])("trips the breaker when Kora security identity drifts ($feePayer)", async (override) => {
    const { repository, budgetRedis, getTransaction, run } = harness(reservation(override));
    await expect(run()).rejects.toThrow("failed reconciliation");
    expect(repository.tripGlobalBreaker).toHaveBeenCalledWith(
      "devnet",
      expect.stringContaining("configuration changed")
    );
    expect(budgetRedis.syncPolicy).toHaveBeenCalledOnce();
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it("trips the breaker when Kora security configuration cannot be read", async () => {
    const candidate = reservation();
    const { repository, budgetRedis, getTransaction } = harness(candidate);
    await expect(
      reconcileSponsorshipBudgets({ SOLANA_NETWORK: "devnet" } as Env, {
        repository,
        budgetRedis,
        getTransaction,
        isBlockhashValid: vi.fn(),
        getProviderConfiguration: vi.fn().mockRejectedValue(new Error("Kora unavailable")),
        now: () => new Date("2026-08-03T10:05:00.000Z"),
      })
    ).rejects.toThrow("configuration is unavailable");
    expect(repository.tripGlobalBreaker).toHaveBeenCalledWith(
      "devnet",
      expect.stringContaining("unavailable")
    );
    expect(getTransaction).not.toHaveBeenCalled();
  });
});

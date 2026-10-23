import * as feePaymentChainReads from "@sdp/fee-payment/chain-reads";
import { runInClusterScope } from "@sdp/rpc/scope";
import * as solanaRpc from "@sdp/rpc/solana";
import { address, blockhash, signature } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SponsorshipReconciliationReservation } from "@/db/repositories/sponsorship-budget.repository";
import { runInEnvironmentClusterScope } from "@/runtime/cluster-scope-runs";
import { sponsorshipProviderConfigFingerprint } from "@/services/sponsorship-budget.service";
import { env as testEnv } from "@/test/helpers/env";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
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
const LAST_VALID_BLOCK_HEIGHT = 500n;
const FINALIZED_SLOT = 41n;
const PRICING_SLOT = 37n;
const LANDED_STATUS: solanaRpc.SignatureStatusInfo = {
  slot: 40n,
  confirmations: 3n,
  confirmationStatus: "confirmed",
  err: null,
};

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
    lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
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
    listReconciliationCandidates: vi.fn(async (network: string) =>
      network === candidate.network ? [candidate] : []
    ),
    recordReconciliationMiss: vi.fn().mockResolvedValue(true),
    settleReservation: vi.fn().mockResolvedValue(true),
    markChargedUnknown: vi.fn().mockResolvedValue(true),
    getReservation: vi.fn().mockResolvedValue(null),
    getGlobalPolicy: vi.fn().mockResolvedValue({ ...breakerPolicy, enabled: true }),
    tripGlobalBreaker: vi.fn().mockResolvedValue(breakerPolicy),
    resumeGlobalBreaker: vi.fn().mockResolvedValue(null),
    recordProviderConfigFailure: vi.fn().mockResolvedValue(1),
    resetProviderConfigFailures: vi.fn().mockResolvedValue(undefined),
    markRedisSettled: vi.fn().mockResolvedValue(true),
  };
  const budgetRedis = {
    settle: vi.fn().mockResolvedValue(0),
    syncPolicy: vi.fn().mockResolvedValue(undefined),
  };
  const getTransaction = vi.fn().mockResolvedValue({
    slot: 1n,
    accountKeys: [PROVIDER_CONFIGURATION.signerAddress],
    err: null,
    fee: 1n,
    preBalances: [10n],
    postBalances: [7n],
    instructions: [],
  });
  const finalizedHeight = vi
    .fn<typeof feePaymentChainReads.sponsoredFinalizedHeight>()
    .mockResolvedValue({ blockHeight: 1n, absoluteSlot: 1n });
  const getSignatureStatus = vi.fn<typeof feePaymentChainReads.getSponsoredSignatureStatus>();
  const run = () =>
    runInEnvironmentClusterScope("sandbox", () =>
      reconcileSponsorshipBudgets(testEnv, {
        repository,
        budgetRedis,
        getTransaction,
        finalizedHeight,
        getSignatureStatus,
        getProviderConfiguration: vi.fn().mockResolvedValue(PROVIDER_CONFIGURATION),
        now: () => new Date("2026-08-03T10:05:00.000Z"),
        sleep: vi.fn().mockResolvedValue(undefined),
      })
    );
  return { repository, budgetRedis, getTransaction, finalizedHeight, getSignatureStatus, run };
}

function expiredHarness(candidate: SponsorshipReconciliationReservation) {
  const reconciliation = harness(candidate);
  reconciliation.getTransaction.mockResolvedValueOnce(null);
  reconciliation.finalizedHeight.mockResolvedValueOnce({
    blockHeight: LAST_VALID_BLOCK_HEIGHT + 1n,
    absoluteSlot: FINALIZED_SLOT,
  });
  return reconciliation;
}

describe("reconcileSponsorshipBudgets", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads chain state through the Fee Payer's own upstream when no reads are injected", async () => {
    const { repository, budgetRedis } = harness(reservation());
    const getSponsoredTransaction = vi
      .spyOn(feePaymentChainReads, "getSponsoredTransaction")
      .mockResolvedValueOnce(null);
    const sponsoredFinalizedHeight = vi
      .spyOn(feePaymentChainReads, "sponsoredFinalizedHeight")
      .mockResolvedValueOnce({ blockHeight: 1n, absoluteSlot: 1n });

    await runInEnvironmentClusterScope("sandbox", () =>
      reconcileSponsorshipBudgets(testEnv, {
        repository,
        budgetRedis,
        getProviderConfiguration: vi.fn().mockResolvedValue(PROVIDER_CONFIGURATION),
        now: () => new Date("2026-08-03T10:05:00.000Z"),
        sleep: vi.fn().mockResolvedValue(undefined),
      })
    );

    expect(getSponsoredTransaction).toHaveBeenCalledExactlyOnceWith(TEST_SIGNATURE);
    expect(sponsoredFinalizedHeight).toHaveBeenCalledOnce();
    expect(repository.settleReservation).not.toHaveBeenCalled();
  });

  it("reconciles only the cluster scope's network", async () => {
    const { repository, run } = harness(reservation());
    repository.listReconciliationCandidates.mockImplementation(async (network: string) =>
      network === "mainnet"
        ? [reservation({ id: "reservation_mainnet", network: "mainnet" })]
        : [reservation()]
    );

    await expect(run()).resolves.toBeUndefined();

    expect(repository.listReconciliationCandidates.mock.calls.map(([network]) => network)).toEqual([
      "devnet",
    ]);
    expect(repository.settleReservation).toHaveBeenCalledExactlyOnceWith(
      "reservation_1",
      1,
      "committed",
      3,
      undefined
    );
  });

  it("reports a network with outstanding reservations but no readable paymaster as a failed pass", async () => {
    const { repository, budgetRedis, getTransaction, finalizedHeight } = harness(
      reservation({ id: "reservation_mainnet", network: "mainnet" })
    );
    const getProviderConfiguration = vi
      .fn()
      .mockRejectedValue(new Error("Kora is not configured for mainnet-beta"));

    await expect(
      runInEnvironmentClusterScope("production", () =>
        reconcileSponsorshipBudgets(testEnv, {
          repository,
          budgetRedis,
          getTransaction,
          finalizedHeight,
          getProviderConfiguration,
          now: () => new Date("2026-08-03T10:05:00.000Z"),
          sleep: vi.fn().mockResolvedValue(undefined),
        })
      )
    ).rejects.toThrow("Kora security configuration is unavailable");

    expect(repository.recordProviderConfigFailure).toHaveBeenCalledWith("mainnet");
    expect(repository.settleReservation).not.toHaveBeenCalled();
  });

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
      accountKeys: [PROVIDER_CONFIGURATION.signerAddress],
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
      accountKeys: [PROVIDER_CONFIGURATION.signerAddress],
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

  it("charges a finalized transaction naming another fee payer as unknown without settling it", async () => {
    const { repository, budgetRedis, getTransaction, run } = harness(reservation());
    getTransaction.mockResolvedValueOnce({
      slot: 1n,
      accountKeys: [syntheticAddress(1)],
      err: null,
      fee: 1n,
      preBalances: [10n],
      postBalances: [7n],
      instructions: [],
    });

    await expect(run()).resolves.toBeUndefined();

    expect(repository.markChargedUnknown).toHaveBeenCalledExactlyOnceWith(
      "reservation_1",
      1,
      expect.stringContaining("different fee payer")
    );
    expect(repository.settleReservation).not.toHaveBeenCalled();
    expect(budgetRedis.settle).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        event: "sdp_api_sponsorship_settlement_fee_payer_mismatch",
        reservation_id: "reservation_1",
        reserved_fee_payer: PROVIDER_CONFIGURATION.signerAddress,
        transaction_fee_payer: syntheticAddress(1),
      })
    );
  });

  it("retains the full reservation when RPC state is uncertain", async () => {
    const { repository, budgetRedis, getTransaction, run } = harness(reservation());
    getTransaction.mockRejectedValueOnce(new Error("RPC timeout"));
    await expect(run()).rejects.toThrow("failed reconciliation");
    expect(repository.settleReservation).not.toHaveBeenCalled();
    expect(budgetRedis.settle).not.toHaveBeenCalled();
  });

  it("keeps a reservation open while the finalized height has not passed its bound", async () => {
    const { repository, budgetRedis, getTransaction, finalizedHeight, getSignatureStatus, run } =
      harness(reservation());
    getTransaction.mockResolvedValueOnce(null);
    finalizedHeight.mockResolvedValueOnce({
      blockHeight: LAST_VALID_BLOCK_HEIGHT,
      absoluteSlot: FINALIZED_SLOT,
    });

    await expect(run()).resolves.toBeUndefined();

    expect(getSignatureStatus).not.toHaveBeenCalled();
    expect(repository.recordReconciliationMiss).not.toHaveBeenCalled();
    expect(repository.settleReservation).not.toHaveBeenCalled();
    expect(repository.markChargedUnknown).not.toHaveBeenCalled();
    expect(budgetRedis.settle).not.toHaveBeenCalled();
  });

  it("releases a reservation past its bound whose signature is absent from history", async () => {
    const { repository, budgetRedis, getSignatureStatus, run } = expiredHarness(
      reservation({ status: "signed" })
    );
    getSignatureStatus.mockResolvedValueOnce(null);

    await expect(run()).resolves.toBeUndefined();

    expect(repository.listReconciliationCandidates).toHaveBeenCalledWith(
      "devnet",
      "2026-08-03T10:03:00.000Z",
      250
    );
    expect(getSignatureStatus).toHaveBeenCalledExactlyOnceWith(TEST_SIGNATURE, FINALIZED_SLOT);
    expect(repository.settleReservation).toHaveBeenCalledExactlyOnceWith(
      "reservation_1",
      1,
      "released",
      0,
      expect.stringContaining("absent from history")
    );
    expect(budgetRedis.settle).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: "reservation_1", attempt: 1, actualLamports: 0 })
    );
    expect(repository.markChargedUnknown).not.toHaveBeenCalled();
  });

  it("waits for finality while an expired reservation's signature has landed", async () => {
    const { repository, budgetRedis, getSignatureStatus, run } = expiredHarness(
      reservation({ missCount: 9 })
    );
    getSignatureStatus.mockResolvedValueOnce(LANDED_STATUS);

    await expect(run()).resolves.toBeUndefined();

    expect(repository.recordReconciliationMiss).toHaveBeenCalledExactlyOnceWith(
      "reservation_1",
      1,
      9
    );
    expect(repository.settleReservation).not.toHaveBeenCalled();
    expect(repository.markChargedUnknown).not.toHaveBeenCalled();
    expect(budgetRedis.settle).not.toHaveBeenCalled();
  });

  it("charges a landed signature that never finalized within the wait as unknown", async () => {
    const { repository, budgetRedis, getSignatureStatus, run } = expiredHarness(
      reservation({ missCount: 10 })
    );
    getSignatureStatus.mockResolvedValueOnce(LANDED_STATUS);

    await expect(run()).resolves.toBeUndefined();

    expect(repository.markChargedUnknown).toHaveBeenCalledExactlyOnceWith(
      "reservation_1",
      1,
      expect.stringContaining("never finalized")
    );
    expect(repository.recordReconciliationMiss).not.toHaveBeenCalled();
    expect(repository.settleReservation).not.toHaveBeenCalled();
    expect(budgetRedis.settle).not.toHaveBeenCalled();
  });

  it("retains an expired reservation when the status node refuses to answer from the height read's slot", async () => {
    const { repository, budgetRedis, getSignatureStatus, run } = expiredHarness(
      reservation({ missCount: 1 })
    );
    getSignatureStatus.mockRejectedValueOnce(
      new Error("Minimum context slot has not been reached")
    );

    await expect(run()).rejects.toThrow("failed reconciliation");

    expect(repository.recordReconciliationMiss).not.toHaveBeenCalled();
    expect(repository.settleReservation).not.toHaveBeenCalled();
    expect(repository.markChargedUnknown).not.toHaveBeenCalled();
    expect(budgetRedis.settle).not.toHaveBeenCalled();
  });

  it("charges a reservation admitted before the stored bound as unknown without reading the height", async () => {
    const { repository, budgetRedis, getTransaction, finalizedHeight, getSignatureStatus, run } =
      harness(reservation({ lastValidBlockHeight: null }));
    getTransaction.mockResolvedValueOnce(null);

    await expect(run()).resolves.toBeUndefined();

    expect(repository.markChargedUnknown).toHaveBeenCalledExactlyOnceWith(
      "reservation_1",
      1,
      expect.stringContaining("predates the stored last valid block height")
    );
    expect(finalizedHeight).not.toHaveBeenCalled();
    expect(getSignatureStatus).not.toHaveBeenCalled();
    expect(repository.settleReservation).not.toHaveBeenCalled();
    expect(budgetRedis.settle).not.toHaveBeenCalled();
  });

  it("commits a finalized transaction's spend even when its reservation predates the stored bound", async () => {
    const { repository, run } = harness(reservation({ lastValidBlockHeight: null }));

    await expect(run()).resolves.toBeUndefined();

    expect(repository.settleReservation).toHaveBeenCalledExactlyOnceWith(
      "reservation_1",
      1,
      "committed",
      3,
      undefined
    );
    expect(repository.markChargedUnknown).not.toHaveBeenCalled();
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

  it("records a config failure without tripping while under the consecutive threshold", async () => {
    const candidate = reservation();
    const { repository, budgetRedis, getTransaction } = harness(candidate);
    const getProviderConfiguration = vi.fn().mockRejectedValue(new Error("Kora unavailable"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      runInEnvironmentClusterScope("sandbox", () =>
        reconcileSponsorshipBudgets(testEnv, {
          repository,
          budgetRedis,
          getTransaction,
          finalizedHeight: vi.fn(),
          getProviderConfiguration,
          now: () => new Date("2026-08-03T10:05:00.000Z"),
          sleep,
        })
      )
    ).rejects.toThrow("configuration is unavailable");
    expect(getProviderConfiguration).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(repository.recordProviderConfigFailure).toHaveBeenCalledWith("devnet");
    expect(repository.tripGlobalBreaker).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        event: "sdp_api_sponsorship_config_read_failed",
        consecutive_failures: 1,
      })
    );
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it("trips the breaker after the consecutive config-failure threshold", async () => {
    const candidate = reservation();
    const { repository, budgetRedis, getTransaction } = harness(candidate);
    repository.recordProviderConfigFailure.mockResolvedValue(3);
    await expect(
      runInEnvironmentClusterScope("sandbox", () =>
        reconcileSponsorshipBudgets(testEnv, {
          repository,
          budgetRedis,
          getTransaction,
          finalizedHeight: vi.fn(),
          getProviderConfiguration: vi.fn().mockRejectedValue(new Error("Kora unavailable")),
          now: () => new Date("2026-08-03T10:05:00.000Z"),
          sleep: vi.fn().mockResolvedValue(undefined),
        })
      )
    ).rejects.toThrow("configuration is unavailable");
    expect(repository.tripGlobalBreaker).toHaveBeenCalledWith(
      "devnet",
      expect.stringContaining("unavailable"),
      { recoverable: true }
    );
    expect(repository.resetProviderConfigFailures).not.toHaveBeenCalled();
  });

  it("resets the consecutive failure counter on a successful config read", async () => {
    const { repository, run } = harness(reservation());
    await expect(run()).resolves.toBeUndefined();
    expect(repository.resetProviderConfigFailures).toHaveBeenCalledWith("devnet");
    expect(repository.recordProviderConfigFailure).not.toHaveBeenCalled();
  });

  it("does not trip the breaker when a config read succeeds on retry", async () => {
    const candidate = reservation();
    const { repository, budgetRedis, getTransaction, finalizedHeight } = harness(candidate);
    const getProviderConfiguration = vi
      .fn()
      .mockRejectedValueOnce(new Error("Kora unavailable"))
      .mockResolvedValue(PROVIDER_CONFIGURATION);
    await expect(
      runInEnvironmentClusterScope("sandbox", () =>
        reconcileSponsorshipBudgets(testEnv, {
          repository,
          budgetRedis,
          getTransaction,
          finalizedHeight,
          getProviderConfiguration,
          now: () => new Date("2026-08-03T10:05:00.000Z"),
          sleep: vi.fn().mockResolvedValue(undefined),
        })
      )
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
      accountKeys: [PROVIDER_CONFIGURATION.signerAddress],
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
      runInEnvironmentClusterScope("sandbox", () =>
        reconcileSponsorshipBudgets(testEnv, {
          repository,
          budgetRedis,
          getTransaction,
          finalizedHeight: vi.fn(),
          getProviderConfiguration: vi.fn().mockRejectedValue(new Error("Kora unavailable")),
          now: () => new Date("2026-08-03T10:05:00.000Z"),
          sleep: vi.fn().mockResolvedValue(undefined),
        })
      )
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

describe("getSponsoredTransaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("reads the transaction from Kora's upstream at finalized", async () => {
    vi.stubEnv("KORA_DEVNET_RPC_URL", "https://kora-devnet-rpc.sdp.test");
    const getTransaction = vi.spyOn(solanaRpc, "getTransaction").mockResolvedValueOnce(null);

    await runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      feePaymentChainReads.getSponsoredTransaction(signature(TEST_SIGNATURE))
    );

    expect(getTransaction).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      TEST_SIGNATURE,
      "finalized"
    );
  });
});

describe("sponsored chain reads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("bounds the last valid block height from a bank at or past the pricing slot", async () => {
    vi.stubEnv("KORA_DEVNET_RPC_URL", "https://kora-devnet-rpc.sdp.test");
    const transaction = new Uint8Array([1, 2, 3]);
    const getTransactionNetworkFee = vi
      .spyOn(solanaRpc, "getTransactionNetworkFee")
      .mockResolvedValueOnce({ fee: 5_000n, contextSlot: PRICING_SLOT });
    const getRecentBlockhash = vi.spyOn(solanaRpc, "getRecentBlockhash").mockResolvedValueOnce({
      blockhash: blockhash(TEST_BLOCKHASH),
      lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
    });

    await expect(
      runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
        feePaymentChainReads.priceSponsoredTransaction(transaction)
      )
    ).resolves.toEqual({ networkFee: 5_000n, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT });

    expect(getTransactionNetworkFee).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      transaction,
      "confirmed"
    );
    expect(getRecentBlockhash).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      "confirmed",
      PRICING_SLOT
    );
  });

  it("reads the chain height from Kora's upstream at finalized", async () => {
    vi.stubEnv("KORA_DEVNET_RPC_URL", "https://kora-devnet-rpc.sdp.test");
    const getChainHeight = vi.spyOn(solanaRpc, "getChainHeight").mockResolvedValueOnce({
      blockHeight: LAST_VALID_BLOCK_HEIGHT,
      absoluteSlot: FINALIZED_SLOT,
    });

    await runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      feePaymentChainReads.sponsoredFinalizedHeight()
    );

    expect(getChainHeight).toHaveBeenCalledExactlyOnceWith(expect.anything(), "finalized");
  });

  it("searches signature history on a node at least as current as the height read", async () => {
    vi.stubEnv("KORA_DEVNET_RPC_URL", "https://kora-devnet-rpc.sdp.test");
    const getSignatureStatuses = vi
      .spyOn(solanaRpc, "getSignatureStatuses")
      .mockResolvedValueOnce([null]);

    await expect(
      runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
        feePaymentChainReads.getSponsoredSignatureStatus(signature(TEST_SIGNATURE), FINALIZED_SLOT)
      )
    ).resolves.toBeNull();

    expect(getSignatureStatuses).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      [TEST_SIGNATURE],
      { searchTransactionHistory: true, minContextSlot: FINALIZED_SLOT }
    );
  });
});

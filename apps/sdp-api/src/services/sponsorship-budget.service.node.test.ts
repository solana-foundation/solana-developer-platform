import { FeePaymentError, type FeePaymentPort } from "@sdp/fee-payment/port";
import { runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase58Codec,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SponsorshipBudgetPolicy } from "@/db/repositories/sponsorship-budget.repository";
import { type MoneyAdmissionFacts, MoneyMovementRefusedError } from "@/lib/money-admission";
import { admittedMoneyFacts } from "@/test/helpers/money-admission";
import {
  garbageSignTestTransaction,
  sponsorSignTestTransaction,
  TEST_MOCK_FEE_PAYER,
} from "@/test/helpers/sponsor-signing";
import type { Env } from "@/types/env";
import type { SponsorshipMovementScope } from "./sponsorship.service";
import {
  BudgetedFeePayment,
  sponsorshipProviderConfigFingerprint,
} from "./sponsorship-budget.service";

const logEvent = vi.hoisted(() => vi.fn());
// The real reader queries Postgres; the admission decision itself stays real.
const readMoneyAdmissionFacts = vi.hoisted(() => vi.fn());

vi.mock("@/lib/money-admission", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/money-admission")>()),
  readMoneyAdmissionFacts,
}));

vi.mock("@/runtime/money-path-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/runtime/money-path-events")>()),
  logEvent,
}));

const FEE_PAYER = TEST_MOCK_FEE_PAYER;
const BLOCKHASH = getBase58Codec().decode(new Uint8Array(32).fill(7)) as Blockhash;
const PRICED_LAST_VALID_BLOCK_HEIGHT = 160n;
const SCOPE: SponsorshipMovementScope = {
  organizationId: "org_1",
  projectId: "project_1",
  actor: { type: "api_key", id: "key_1" },
  movement: "payments.transfer",
  custodyWalletId: "cwlt_1",
};

const ACTIVE_SANDBOX: MoneyAdmissionFacts = admittedMoneyFacts();

const ACTIVE_ENTITLED_PRODUCTION: MoneyAdmissionFacts = admittedMoneyFacts({
  projectEnvironment: "production",
  rawSettings: JSON.stringify({ enableProductionProject: true }),
});

function buildTransaction(version: 0 | "legacy" = 0): Uint8Array {
  const message = pipe(
    createTransactionMessage({ version }),
    (current) => setTransactionMessageFeePayer(FEE_PAYER, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
        current
      )
  );
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
}

function policy(
  scopeType: SponsorshipBudgetPolicy["scopeType"],
  enabled = true
): SponsorshipBudgetPolicy {
  return {
    id: `policy_${scopeType}`,
    network: "devnet",
    scopeType,
    scopeId: null,
    enabled,
    perTransactionLamports: 10_000_000,
    hourlyLamports: 1_000_000_000,
    dailyLamports: 3_000_000_000,
    version: enabled ? 1 : 2,
    updatedBy: "test",
    updateReason: "test",
    updatedAt: new Date(0).toISOString(),
  };
}

function harnessParts() {
  const repository = {
    resolvePolicies: vi
      .fn()
      .mockResolvedValue([policy("global"), policy("organization"), policy("project")]),
    loadWindowAdmissionSnapshot: vi.fn().mockResolvedValue({
      usage: {
        hour: { global: 0, organization: 0, project: 0 },
        day: { global: 0, organization: 0, project: 0 },
      },
      liveReservations: { hour: [], day: [] },
    }),
    getReservation: vi.fn().mockResolvedValue(null),
    createReservation: vi.fn().mockResolvedValue(true),
    reopenReleasedReservation: vi.fn().mockResolvedValue(null),
    markSigned: vi.fn().mockResolvedValue("persisted"),
    markSubmitted: vi.fn().mockResolvedValue("persisted"),
    markChargedUnknown: vi.fn().mockResolvedValue(true),
    markReleased: vi.fn().mockResolvedValue(true),
    settleReservation: vi.fn().mockResolvedValue(true),
    markRedisSettled: vi.fn().mockResolvedValue(true),
    tripGlobalBreaker: vi.fn().mockResolvedValue(null),
  };
  const budgetRedis = {
    reserve: vi.fn().mockResolvedValue("admitted" as const),
    cancel: vi.fn().mockResolvedValue(undefined),
    settle: vi.fn().mockResolvedValue(0),
    syncPolicy: vi.fn().mockResolvedValue(undefined),
  };
  const provider: FeePaymentPort = {
    providerId: "kora",
    getFeePayer: vi.fn().mockResolvedValue(FEE_PAYER),
    getSponsorshipConfiguration: vi.fn().mockResolvedValue({
      signerAddress: FEE_PAYER,
      maxAllowedLamports: 1_000_000n,
      feePayerMayTransferLamports: false,
      feePayerPolicy: { system: { allow_transfer: false } },
    }),
    signAsFeePayer: vi.fn().mockImplementation(sponsorSignTestTransaction),
  };
  const readAdmissionFacts = readMoneyAdmissionFacts.mockReset().mockResolvedValue(ACTIVE_SANDBOX);
  return { provider, repository, budgetRedis, readAdmissionFacts };
}

function harness(scope: SponsorshipMovementScope = SCOPE) {
  return harnessIn("sandbox", scope);
}

function harnessIn(environment: SdpEnvironment, scope: SponsorshipMovementScope) {
  const parts = harnessParts();
  const feePayment = runInClusterScope(
    { projectId: scope.projectId, environment },
    () =>
      new BudgetedFeePayment({ SOLANA_NETWORK: "devnet" } as Env, scope, parts.provider, {
        repository: parts.repository,
        budgetRedis: parts.budgetRedis,
        priceTransaction: vi.fn().mockResolvedValue({
          networkFee: 5_000n,
          lastValidBlockHeight: PRICED_LAST_VALID_BLOCK_HEIGHT,
        }),
        now: () => new Date("2026-08-03T10:15:00.000Z"),
      })
  );
  return { feePayment, ...parts };
}

describe("BudgetedFeePayment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves the underlying provider contract identifier", () => {
    expect(harness().feePayment.providerId).toBe("kora");
  });

  it.each([0, "legacy"] as const)(
    "admits and persists %s transaction messages",
    async (version) => {
      const { feePayment, repository } = harness();
      await expect(feePayment.signAsFeePayer(buildTransaction(version))).resolves.toBeInstanceOf(
        Uint8Array
      );
      expect(repository.createReservation).toHaveBeenCalledOnce();
    }
  );

  it("stores the priced last valid block height bound on the reservation", async () => {
    const { feePayment, repository } = harness();
    await expect(feePayment.signAsFeePayer(buildTransaction())).resolves.toBeInstanceOf(Uint8Array);
    expect(repository.createReservation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        recentBlockhash: BLOCKHASH,
        lastValidBlockHeight: PRICED_LAST_VALID_BLOCK_HEIGHT,
      })
    );
  });

  it("commits the durable reservation before touching the Redis budget gate", async () => {
    const { feePayment, repository, budgetRedis } = harness();
    await expect(feePayment.signAsFeePayer(buildTransaction())).resolves.toBeInstanceOf(Uint8Array);
    const created = repository.createReservation.mock.invocationCallOrder[0];
    const reserved = budgetRedis.reserve.mock.invocationCallOrder[0];
    expect(created).toBeLessThan(reserved);
  });

  it("charges a production project's mainnet network, not the process default", async () => {
    const { feePayment, repository } = harnessIn("production", SCOPE);
    readMoneyAdmissionFacts.mockResolvedValue(ACTIVE_ENTITLED_PRODUCTION);
    repository.resolvePolicies.mockResolvedValue([
      { ...policy("global"), network: "mainnet" },
      { ...policy("organization"), network: "mainnet" },
      { ...policy("project"), network: "mainnet" },
    ]);

    await expect(feePayment.signAsFeePayer(buildTransaction())).resolves.toBeInstanceOf(Uint8Array);

    expect(repository.resolvePolicies.mock.calls[0]?.[0]).toMatchObject({ network: "mainnet" });
    expect(repository.createReservation.mock.calls[0]?.[0]).toMatchObject({
      network: "mainnet",
      productEnvironment: "production",
    });
  });

  it("excludes the current reservation from the reconstruction snapshot", async () => {
    const { feePayment, repository } = harness();
    await expect(feePayment.signAsFeePayer(buildTransaction())).resolves.toBeInstanceOf(Uint8Array);
    const createdId = repository.createReservation.mock.calls[0]?.[0].id;
    expect(repository.loadWindowAdmissionSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ excludeReservationId: createdId })
    );
  });

  it("denies the tiny-limit Surfpool/Kora canary before Kora or KMS execution", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    repository.resolvePolicies.mockResolvedValueOnce([
      { ...policy("global"), perTransactionLamports: 1 },
      { ...policy("organization"), perTransactionLamports: 1 },
      { ...policy("project"), perTransactionLamports: 1 },
    ]);
    budgetRedis.reserve.mockResolvedValueOnce("denied");

    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(budgetRedis.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1_005_000 })
    );
    expect(provider.signAsFeePayer).not.toHaveBeenCalled();
    expect(repository.createReservation).toHaveBeenCalledOnce();
    expect(repository.markReleased).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "budget exceeded during admission"
    );
  });

  it("reserves network fee plus Kora's full outflow ceiling even when its policy denies transfers", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    vi.mocked(provider.getSponsorshipConfiguration).mockResolvedValueOnce({
      signerAddress: FEE_PAYER,
      maxAllowedLamports: 1_000_000n,
      feePayerMayTransferLamports: false,
      feePayerPolicy: { system: { allow_transfer: false } },
    });
    repository.resolvePolicies.mockResolvedValueOnce([
      { ...policy("global"), perTransactionLamports: 1_000_000 },
      { ...policy("organization"), perTransactionLamports: 1_000_000 },
      { ...policy("project"), perTransactionLamports: 1_000_000 },
    ]);
    budgetRedis.reserve.mockImplementationOnce(async (input) =>
      input.amount > 1_000_000 ? "denied" : "admitted"
    );

    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(budgetRedis.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1_005_000 })
    );
    expect(provider.signAsFeePayer).not.toHaveBeenCalled();
    expect(repository.createReservation).toHaveBeenCalledOnce();
    expect(repository.markReleased).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "budget exceeded during admission"
    );
  });

  it("keeps the outflow flag as a provider configuration fingerprint input", () => {
    const configuration = {
      signerAddress: FEE_PAYER,
      maxAllowedLamports: 1_000_000n,
      feePayerMayTransferLamports: false,
      feePayerPolicy: { system: { allow_transfer: false } },
    };
    expect(
      sponsorshipProviderConfigFingerprint({ ...configuration, feePayerMayTransferLamports: true })
    ).not.toBe(sponsorshipProviderConfigFingerprint(configuration));
  });

  it("retries the Redis gate under a refreshed policy without recreating the durable row", async () => {
    const { feePayment, repository, budgetRedis } = harness();
    budgetRedis.reserve.mockResolvedValueOnce("stale_policy");
    await expect(feePayment.signAsFeePayer(buildTransaction())).resolves.toBeInstanceOf(Uint8Array);
    expect(budgetRedis.reserve).toHaveBeenCalledTimes(2);
    expect(repository.createReservation).toHaveBeenCalledOnce();
    expect(repository.markReleased).not.toHaveBeenCalled();
  });

  it("fails closed and releases once when the policy stays stale across both attempts", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    budgetRedis.reserve.mockResolvedValue("stale_policy");
    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
    expect(budgetRedis.reserve).toHaveBeenCalledTimes(2);
    expect(repository.createReservation).toHaveBeenCalledOnce();
    expect(repository.markReleased).toHaveBeenCalledOnce();
    expect(provider.signAsFeePayer).not.toHaveBeenCalled();
  });

  it("releases the durable row when the policy is disabled before the retry", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    budgetRedis.reserve.mockResolvedValueOnce("stale_policy");
    repository.resolvePolicies
      .mockResolvedValueOnce([policy("global"), policy("organization"), policy("project")])
      .mockResolvedValue([policy("global", false), policy("organization"), policy("project")]);

    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
    expect(repository.createReservation).toHaveBeenCalledOnce();
    expect(repository.markReleased).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "sponsorship disabled during admission"
    );
    expect(provider.signAsFeePayer).not.toHaveBeenCalled();
  });

  it("leaves an admission-released reservation reopenable by a later retry", async () => {
    const { feePayment, repository, budgetRedis } = harness();
    budgetRedis.reserve.mockResolvedValueOnce("denied");

    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(repository.markReleased).toHaveBeenCalledOnce();
    expect(repository.markRedisSettled).toHaveBeenCalledWith(expect.any(String), 1);
  });

  it("releases a sign-only reservation when Kora returns a structured policy rejection", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    vi.mocked(provider.signAsFeePayer).mockRejectedValueOnce(
      new FeePaymentError(
        "Kora Error -32001: Validation error: Mutable transfer-hook authority found on mint account",
        "PROVIDER_REJECTED"
      )
    );

    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_REJECTED",
    });

    expect(repository.markReleased).toHaveBeenCalledOnce();
    expect(repository.markReleased).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringContaining("Mutable transfer-hook authority")
    );
    expect(repository.markChargedUnknown).not.toHaveBeenCalled();
    expect(budgetRedis.settle).toHaveBeenCalledOnce();
  });

  it("retains ambiguous sign-only failures and blocks an unsafe retry", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    const transaction = buildTransaction();
    vi.mocked(provider.signAsFeePayer).mockRejectedValueOnce(
      new FeePaymentError("KMS response timed out after signing", "SIGNING_FAILED")
    );

    await expect(feePayment.signAsFeePayer(transaction)).rejects.toThrow("timed out");

    expect(repository.markChargedUnknown).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "KMS response timed out after signing"
    );
    expect(repository.markReleased).not.toHaveBeenCalled();
    expect(repository.markRedisSettled).not.toHaveBeenCalled();
    expect(budgetRedis.settle).not.toHaveBeenCalled();

    repository.getReservation.mockResolvedValue({
      id: "reservation_1",
      status: "charged_unknown",
      signature: null,
      signedTransaction: null,
      reservedLamports: 5_000,
      actualLamports: null,
      attempt: 1,
    });
    await expect(feePayment.signAsFeePayer(transaction)).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
    expect(provider.signAsFeePayer).toHaveBeenCalledOnce();
    expect(budgetRedis.reserve).toHaveBeenCalledOnce();
  });

  it("retains an owned submission as ambiguous when sign-only custody fails", async () => {
    const { feePayment, provider, repository } = harness();
    vi.mocked(provider.signAsFeePayer).mockRejectedValueOnce(
      new FeePaymentError("KMS response timed out after signing", "SIGNING_FAILED")
    );
    const lifecycle = {
      persistSigned: vi.fn(),
      markStarted: vi.fn(),
      hasStarted: vi.fn(),
    };

    await expect(feePayment.prepareOwnedSubmission(buildTransaction(), lifecycle)).rejects.toThrow(
      "timed out"
    );

    expect(repository.markReleased).not.toHaveBeenCalled();
    expect(repository.markChargedUnknown).toHaveBeenCalledOnce();
    expect(lifecycle.persistSigned).not.toHaveBeenCalled();
    expect(lifecycle.markStarted).not.toHaveBeenCalled();
  });

  it("releases an owned submission when Kora returns a structured policy rejection", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    vi.mocked(provider.signAsFeePayer).mockRejectedValueOnce(
      new FeePaymentError("Kora Error -32001: Validation error", "PROVIDER_REJECTED")
    );
    const lifecycle = {
      persistSigned: vi.fn(),
      markStarted: vi.fn(),
      hasStarted: vi.fn(),
    };

    await expect(
      feePayment.prepareOwnedSubmission(buildTransaction(), lifecycle)
    ).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });

    expect(repository.markReleased).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "Kora Error -32001: Validation error"
    );
    expect(repository.markChargedUnknown).not.toHaveBeenCalled();
    expect(budgetRedis.settle).toHaveBeenCalledOnce();
    expect(lifecycle.persistSigned).not.toHaveBeenCalled();
  });

  it("releases an owned submission when its signed payment cannot be persisted", async () => {
    const { feePayment, repository, budgetRedis } = harness();
    const lifecycle = {
      persistSigned: vi.fn().mockRejectedValue(new Error("payment persistence failed")),
      markStarted: vi.fn(),
      hasStarted: vi.fn(),
    };

    await expect(feePayment.prepareOwnedSubmission(buildTransaction(), lifecycle)).rejects.toThrow(
      "payment persistence failed"
    );

    expect(repository.markSigned).toHaveBeenCalledOnce();
    expect(repository.markReleased).toHaveBeenCalledOnce();
    expect(budgetRedis.settle).toHaveBeenCalledWith(
      expect.objectContaining({ actualLamports: 0, detectMissingReservation: true })
    );
    expect(lifecycle.markStarted).not.toHaveBeenCalled();
  });

  it("releases an owned submission killed after signing before anything is persisted", async () => {
    const { feePayment, repository, budgetRedis } = harness();
    repository.resolvePolicies
      .mockResolvedValueOnce([policy("global"), policy("organization"), policy("project")])
      .mockResolvedValueOnce([policy("global", false), policy("organization"), policy("project")]);
    const lifecycle = {
      persistSigned: vi.fn().mockResolvedValue(undefined),
      markStarted: vi.fn(),
      hasStarted: vi.fn(),
    };

    await expect(
      feePayment.prepareOwnedSubmission(buildTransaction(), lifecycle)
    ).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
      message: "Sponsorship is disabled for this scope",
    });

    expect(repository.markSigned).not.toHaveBeenCalled();
    expect(lifecycle.persistSigned).not.toHaveBeenCalled();
    expect(lifecycle.markStarted).not.toHaveBeenCalled();
    expect(repository.markReleased).toHaveBeenCalledOnce();
    expect(budgetRedis.settle).toHaveBeenCalledWith(
      expect.objectContaining({ actualLamports: 0, detectMissingReservation: true })
    );
  });

  it("releases the reservation and rethrows when the start marker write fails", async () => {
    const { feePayment, repository, budgetRedis } = harness();
    const markerError = new Error("marker response lost");
    const lifecycle = {
      persistSigned: vi.fn().mockResolvedValue(undefined),
      markStarted: vi.fn().mockRejectedValue(markerError),
    };

    await expect(feePayment.prepareOwnedSubmission(buildTransaction(), lifecycle)).rejects.toBe(
      markerError
    );

    expect(repository.markReleased).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "marker response lost"
    );
    expect(budgetRedis.settle).toHaveBeenCalledWith(
      expect.objectContaining({ actualLamports: 0, detectMissingReservation: true })
    );
    expect(repository.markSubmitted).not.toHaveBeenCalled();
  });

  it("rethrows the marker error when releasing the unstarted reservation fails", async () => {
    const { feePayment, repository } = harness();
    repository.markReleased.mockRejectedValueOnce(new Error("release write failed"));
    const markerError = new Error("marker response lost");
    const lifecycle = {
      persistSigned: vi.fn().mockResolvedValue(undefined),
      markStarted: vi.fn().mockRejectedValue(markerError),
    };

    await expect(feePayment.prepareOwnedSubmission(buildTransaction(), lifecycle)).rejects.toBe(
      markerError
    );

    expect(logEvent).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        event: "sdp_api_sponsorship_unstarted_release_failed",
        reservation_id: expect.any(String),
      })
    );
  });

  it("persists submitted accounting only after the owned marker is durable", async () => {
    const { feePayment, provider, repository } = harness();
    const lifecycle = {
      persistSigned: vi.fn().mockResolvedValue(undefined),
      markStarted: vi.fn().mockResolvedValue(undefined),
      hasStarted: vi.fn(),
    };

    const submission = await feePayment.prepareOwnedSubmission(buildTransaction(), lifecycle);

    expect(lifecycle.persistSigned).toHaveBeenCalledWith(submission);
    expect(repository.markSubmitted).toHaveBeenCalledWith(
      expect.any(String),
      1,
      submission.signature
    );
    expect(lifecycle.persistSigned.mock.invocationCallOrder[0]).toBeLessThan(
      lifecycle.markStarted.mock.invocationCallOrder[0]
    );
    expect(repository.resolvePolicies.mock.invocationCallOrder[1]).toBeLessThan(
      lifecycle.markStarted.mock.invocationCallOrder[0]
    );
    expect(lifecycle.markStarted.mock.invocationCallOrder[0]).toBeLessThan(
      repository.markSubmitted.mock.invocationCallOrder[0]
    );
    expect(provider.getSponsorshipConfiguration).toHaveBeenCalledOnce();
    expect(repository.markReleased).not.toHaveBeenCalled();
  });

  it("releases a submitted reservation when RPC preflight proves it was not broadcast", async () => {
    const { feePayment, repository, budgetRedis } = harness();
    const lifecycle = {
      persistSigned: vi.fn().mockResolvedValue(undefined),
      markStarted: vi.fn().mockResolvedValue(undefined),
      hasStarted: vi.fn(),
    };
    const submission = await feePayment.prepareOwnedSubmission(buildTransaction(), lifecycle);

    await submission.releaseDefinitelyUnbroadcast(new Error("Transaction simulation failed"));

    expect(repository.settleReservation).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "released",
      0,
      "Transaction simulation failed"
    );
    expect(budgetRedis.settle).toHaveBeenCalledWith(
      expect.objectContaining({ actualLamports: 0, detectMissingReservation: true })
    );
    expect(repository.markRedisSettled).toHaveBeenCalledWith(expect.any(String), 1);
  });

  it("never releases after the owned marker when submitted accounting fails", async () => {
    const { feePayment, repository, budgetRedis } = harness();
    repository.markSubmitted.mockRejectedValueOnce(new Error("ledger offline"));
    const lifecycle = {
      persistSigned: vi.fn().mockResolvedValue(undefined),
      markStarted: vi.fn().mockResolvedValue(undefined),
      hasStarted: vi.fn(),
    };

    await expect(
      feePayment.prepareOwnedSubmission(buildTransaction(), lifecycle)
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_AVAILABLE" });

    expect(lifecycle.markStarted).toHaveBeenCalledOnce();
    expect(repository.markReleased).not.toHaveBeenCalled();
    expect(budgetRedis.settle).not.toHaveBeenCalled();
    expect(repository.tripGlobalBreaker).toHaveBeenCalledWith(
      "devnet",
      "Owned submission accounting persistence failed"
    );
  });

  it("fails closed when owned submitted accounting loses its durable transition", async () => {
    const { feePayment, repository, budgetRedis } = harness();
    repository.markSubmitted.mockResolvedValueOnce("stale");
    const lifecycle = {
      persistSigned: vi.fn().mockResolvedValue(undefined),
      markStarted: vi.fn().mockResolvedValue(undefined),
      hasStarted: vi.fn(),
    };

    await expect(
      feePayment.prepareOwnedSubmission(buildTransaction(), lifecycle)
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_AVAILABLE" });

    expect(repository.tripGlobalBreaker).toHaveBeenCalledWith(
      "devnet",
      "Owned submission accounting lost its durable state transition"
    );
    expect(repository.markReleased).not.toHaveBeenCalled();
    expect(budgetRedis.settle).not.toHaveBeenCalled();
  });

  it("releases an owned submission that is not fully signed", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    vi.mocked(provider.signAsFeePayer).mockResolvedValueOnce(buildTransaction());
    const lifecycle = {
      persistSigned: vi.fn(),
      markStarted: vi.fn(),
      hasStarted: vi.fn(),
    };

    await expect(feePayment.prepareOwnedSubmission(buildTransaction(), lifecycle)).rejects.toThrow(
      "missing the sponsor fee-payer signature"
    );

    expect(lifecycle.persistSigned).not.toHaveBeenCalled();
    expect(repository.markSigned).not.toHaveBeenCalled();
    expect(repository.markReleased).toHaveBeenCalledOnce();
    expect(repository.markChargedUnknown).not.toHaveBeenCalled();
    expect(budgetRedis.settle).toHaveBeenCalledWith(
      expect.objectContaining({ actualLamports: 0, detectMissingReservation: true })
    );
  });

  it("treats a substituted message without the sponsor signature as ambiguous", async () => {
    const { feePayment, provider, repository } = harness();
    vi.mocked(provider.signAsFeePayer).mockResolvedValueOnce(buildTransaction("legacy"));

    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toThrow(
      "came back over a different message"
    );

    expect(repository.markReleased).not.toHaveBeenCalled();
    expect(repository.markChargedUnknown).toHaveBeenCalledOnce();
  });

  it("trips the accounting breaker when the sponsor response cannot be decoded", async () => {
    const { feePayment, provider, repository } = harness();
    vi.mocked(provider.signAsFeePayer).mockResolvedValueOnce(new Uint8Array([1, 2, 3]));

    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toThrow(
      "Signed sponsorship result could not be reconstructed"
    );

    expect(repository.tripGlobalBreaker).toHaveBeenCalledOnce();
    expect(repository.markReleased).not.toHaveBeenCalled();
    expect(repository.markChargedUnknown).not.toHaveBeenCalled();
  });

  it("retains a signing reservation as ambiguous when the sponsor signature does not verify", async () => {
    const { feePayment, provider, repository } = harness();
    const requested = buildTransaction();
    vi.mocked(provider.signAsFeePayer).mockResolvedValueOnce(garbageSignTestTransaction(requested));

    await expect(feePayment.signAsFeePayer(requested)).rejects.toThrow(
      "invalid sponsor fee-payer signature"
    );

    expect(repository.markReleased).not.toHaveBeenCalled();
    expect(repository.markChargedUnknown).toHaveBeenCalledOnce();
  });

  it("records the breaker transition with the reason that caused it", async () => {
    const { feePayment, repository } = harness();
    repository.markSigned.mockRejectedValue(new Error("ledger offline"));

    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });

    expect(logEvent).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        event: "sdp_api_sponsorship_accounting_unavailable",
        network: "devnet",
        organization_id: "org_1",
        error_name: "Error",
      })
    );
    expect(logEvent).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        event: "sdp_api_sponsorship_breaker_tripped",
        network: "devnet",
        reason: "Signed sponsorship persistence failed",
      })
    );
    const payloads = logEvent.mock.calls.map(([, payload]) => JSON.stringify(payload));
    expect(payloads.some((payload) => payload.includes("ledger offline"))).toBe(false);
  });

  it("releases the racing reservation instead of tripping the breaker on a duplicate signature", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    repository.markSigned.mockResolvedValue("duplicate_signature");
    await expect(feePayment.signAsFeePayer(buildTransaction())).resolves.toBeInstanceOf(Uint8Array);
    expect(provider.signAsFeePayer).toHaveBeenCalledOnce();
    expect(repository.markReleased).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "Transaction already sponsored under another reservation"
    );
    expect(budgetRedis.settle).toHaveBeenCalled();
    expect(repository.tripGlobalBreaker).not.toHaveBeenCalled();
  });

  it("fails closed when a stale provider callback loses ownership to a retry", async () => {
    const { feePayment, repository, budgetRedis } = harness();
    repository.markSigned.mockResolvedValueOnce("stale");

    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });

    expect(repository.tripGlobalBreaker).toHaveBeenCalledWith(
      "devnet",
      "Signed sponsorship outcome lost its durable state transition"
    );
    expect(budgetRedis.settle).not.toHaveBeenCalled();
  });

  it("leaves a durable terminal-unsynced row when the Redis sync marker write fails", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    vi.mocked(provider.signAsFeePayer).mockRejectedValueOnce(
      new FeePaymentError("rejected", "PROVIDER_REJECTED")
    );
    repository.markRedisSettled.mockRejectedValueOnce(new Error("postgres timeout"));
    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
    expect(repository.markReleased).toHaveBeenCalledOnce();
    expect(budgetRedis.settle).toHaveBeenCalledOnce();
    expect(repository.tripGlobalBreaker).toHaveBeenCalled();
  });

  it("does not let a stale deterministic failure release a newer attempt", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    vi.mocked(provider.signAsFeePayer).mockRejectedValueOnce(
      new FeePaymentError("stale rejection", "PROVIDER_REJECTED")
    );
    repository.markReleased.mockResolvedValueOnce(false);

    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });

    expect(repository.markReleased).toHaveBeenCalledWith(expect.any(String), 1, "stale rejection");
    expect(budgetRedis.settle).not.toHaveBeenCalled();
    expect(repository.markRedisSettled).not.toHaveBeenCalled();
  });

  describe("money admission (HOO-1955)", () => {
    const DELETED = { ...ACTIVE_SANDBOX, organizationStatus: "deleted" };

    it("refuses a new sponsor signature for a start before reserving any budget", async () => {
      const { feePayment, provider, repository, readAdmissionFacts } = harness();
      readAdmissionFacts.mockResolvedValue(DELETED);

      const refusal = await feePayment.signAsFeePayer(buildTransaction()).catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(MoneyMovementRefusedError);
      expect(refusal).toMatchObject({ reason: "organization_inactive" });
      // The sponsor reads the custody wallet it pays for (SOLA9-834).
      expect(readAdmissionFacts).toHaveBeenCalledWith(
        expect.anything(),
        { organizationId: "org_1", projectId: "project_1" },
        { custodyWalletId: "cwlt_1" }
      );
      expect(repository.createReservation).not.toHaveBeenCalled();
      expect(provider.signAsFeePayer).not.toHaveBeenCalled();
    });

    it("returns a sponsorship already signed as it was, whatever the organization's state", async () => {
      const { feePayment, provider, repository, readAdmissionFacts } = harness();
      readAdmissionFacts.mockResolvedValue(DELETED);
      const requested = buildTransaction();
      const stored = await sponsorSignTestTransaction(requested);
      repository.getReservation.mockResolvedValueOnce({
        status: "signed",
        attempt: 1,
        signedTransaction: Buffer.from(stored).toString("base64"),
      });

      await expect(feePayment.signAsFeePayer(requested)).resolves.toEqual(stored);
      expect(provider.signAsFeePayer).not.toHaveBeenCalled();
    });

    it("sponsors an exit for a deleted organization", async () => {
      const { feePayment, provider, readAdmissionFacts } = harness({
        ...SCOPE,
        movement: "recurring.cancel",
      });
      readAdmissionFacts.mockResolvedValue(DELETED);

      await feePayment.signAsFeePayer(buildTransaction());

      expect(provider.signAsFeePayer).toHaveBeenCalledOnce();
    });
  });

  it("replays stored bytes untouched when they carry the requested message", async () => {
    const { feePayment, provider, repository } = harness();
    const requested = buildTransaction();
    const stored = await sponsorSignTestTransaction(requested);
    repository.createReservation.mockResolvedValueOnce(false);
    repository.getReservation.mockResolvedValueOnce({
      status: "signed",
      attempt: 1,
      signedTransaction: Buffer.from(stored).toString("base64"),
    });

    await expect(feePayment.signAsFeePayer(requested)).resolves.toEqual(stored);

    expect(provider.signAsFeePayer).not.toHaveBeenCalled();
    expect(provider.getFeePayer).not.toHaveBeenCalled();
  });

  it("refuses a stored replay whose bytes do not carry the requested message", async () => {
    const { feePayment, provider, repository } = harness();
    const requested = buildTransaction();
    const foreign = await sponsorSignTestTransaction(buildTransaction("legacy"));
    repository.createReservation.mockResolvedValueOnce(false);
    repository.getReservation.mockResolvedValueOnce({
      status: "signed",
      attempt: 1,
      signedTransaction: Buffer.from(foreign).toString("base64"),
    });

    await expect(feePayment.signAsFeePayer(requested)).rejects.toThrow(
      "Stored sponsored transaction does not match the requested message"
    );

    expect(provider.signAsFeePayer).not.toHaveBeenCalled();
    expect(repository.markReleased).not.toHaveBeenCalled();
    expect(repository.markChargedUnknown).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        event: "sdp_api_sponsorship_replay_integrity_failure",
        failure_class: "mismatch",
      })
    );
  });

  it("retains a signing reservation as ambiguous when the sponsor signs a different message", async () => {
    const { feePayment, provider, repository } = harness();
    const requested = buildTransaction();
    const substituted = await sponsorSignTestTransaction(buildTransaction("legacy"));
    vi.mocked(provider.signAsFeePayer).mockResolvedValueOnce(substituted);

    await expect(feePayment.signAsFeePayer(requested)).rejects.toThrow(
      "came back over a different message"
    );

    expect(repository.markReleased).not.toHaveBeenCalled();
    expect(repository.markChargedUnknown).toHaveBeenCalledOnce();
  });

  it("retains an owned submission as ambiguous when the sponsor signs a different message", async () => {
    const { feePayment, provider, repository } = harness();
    const substituted = await sponsorSignTestTransaction(buildTransaction("legacy"));
    vi.mocked(provider.signAsFeePayer).mockResolvedValueOnce(substituted);
    const lifecycle = {
      persistSigned: vi.fn(),
      markStarted: vi.fn(),
      hasStarted: vi.fn(),
    };

    await expect(feePayment.prepareOwnedSubmission(buildTransaction(), lifecycle)).rejects.toThrow(
      "came back over a different message"
    );

    expect(lifecycle.persistSigned).not.toHaveBeenCalled();
    expect(repository.markSigned).not.toHaveBeenCalled();
    expect(repository.markReleased).not.toHaveBeenCalled();
    expect(repository.markChargedUnknown).toHaveBeenCalledOnce();
  });

  it("never lets a duplicate in-progress caller execute Kora", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    repository.createReservation.mockResolvedValueOnce(false);
    repository.getReservation.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "reservation_1",
      status: "reserved",
      signature: null,
      signedTransaction: null,
      reservedLamports: 5_000,
      actualLamports: null,
      attempt: 1,
    });
    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
    expect(provider.signAsFeePayer).not.toHaveBeenCalled();
    expect(budgetRedis.reserve).not.toHaveBeenCalled();
    expect(repository.markReleased).not.toHaveBeenCalled();
  });

  it("does not refund or open the breaker when a persisted reservation already owns the budget", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    budgetRedis.reserve.mockResolvedValue("admitted");
    repository.createReservation.mockResolvedValue(false);
    repository.getReservation.mockResolvedValueOnce(null).mockResolvedValue({
      id: "reservation_1",
      status: "reserved",
      signature: null,
      signedTransaction: null,
      reservedLamports: 5_000,
      actualLamports: null,
      attempt: 1,
    });
    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
    expect(provider.signAsFeePayer).not.toHaveBeenCalled();
    expect(budgetRedis.cancel).not.toHaveBeenCalled();
    expect(repository.tripGlobalBreaker).not.toHaveBeenCalled();
  });

  it("hashes compiled message bytes so added signatures cannot double-reserve", async () => {
    const { feePayment, repository } = harness();
    const first = buildTransaction();
    const second = first.slice();
    if (second.length < 2) throw new Error("Expected a serialized signature slot");
    second[1] = 42;
    await feePayment.signAsFeePayer(first);
    await feePayment.signAsFeePayer(second);
    const calls = repository.createReservation.mock.calls;
    expect(calls[0]?.[0].id).toBe(calls[1]?.[0].id);
    expect(calls[0]?.[0].transactionDigest).toBe(calls[1]?.[0].transactionDigest);
  });

  it("maps uncertain Kora and RPC preflight failures to service unavailable", async () => {
    const { feePayment, provider, repository } = harness();
    vi.mocked(provider.getSponsorshipConfiguration).mockRejectedValueOnce(new Error("offline"));
    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
    expect(repository.createReservation).not.toHaveBeenCalled();
    expect(provider.signAsFeePayer).not.toHaveBeenCalled();
  });

  it("opens the breaker and returns 503 when durable usage reconstruction fails", async () => {
    const { feePayment, provider, repository } = harness();
    repository.loadWindowAdmissionSnapshot.mockRejectedValueOnce(new Error("postgres unavailable"));
    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
    expect(repository.tripGlobalBreaker).toHaveBeenCalledWith(
      "devnet",
      "Budget reconstruction or Redis admission failed"
    );
    expect(provider.signAsFeePayer).not.toHaveBeenCalled();
  });

  it("fails closed without touching Redis when durable reservation persistence fails", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    repository.createReservation.mockRejectedValueOnce(new Error("postgres unavailable"));
    await expect(feePayment.signAsFeePayer(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
    expect(budgetRedis.reserve).not.toHaveBeenCalled();
    expect(budgetRedis.cancel).not.toHaveBeenCalled();
    expect(repository.tripGlobalBreaker).toHaveBeenCalled();
    expect(provider.signAsFeePayer).not.toHaveBeenCalled();
  });

  it("uses a new ownership attempt when retrying a fully released reservation", async () => {
    const { feePayment, repository, budgetRedis } = harness();
    const released = {
      id: "reservation_1",
      status: "released" as const,
      signature: null,
      signedTransaction: null,
      reservedLamports: 5_000,
      actualLamports: 0,
      attempt: 1,
    };
    repository.getReservation.mockResolvedValue(released);
    repository.reopenReleasedReservation.mockResolvedValueOnce(2);

    await expect(feePayment.signAsFeePayer(buildTransaction())).resolves.toBeInstanceOf(Uint8Array);

    expect(budgetRedis.reserve).toHaveBeenCalledWith(expect.objectContaining({ attempt: 2 }));
    expect(repository.createReservation).not.toHaveBeenCalled();
    expect(repository.reopenReleasedReservation).toHaveBeenCalledWith(expect.any(Object), 1);
    expect(repository.markSigned).toHaveBeenCalledWith(
      expect.any(String),
      2,
      expect.any(String),
      expect.any(String)
    );
  });
});

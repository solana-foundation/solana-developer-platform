import { FeePaymentError, type FeePaymentPort } from "@sdp/payments/fee-payment";
import {
  type Address,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase58Codec,
  getTransactionEncoder,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SponsorshipBudgetPolicy } from "@/db/repositories/sponsorship-budget.repository";
import type { Env } from "@/types/env";
import type { SponsorshipScope } from "./sponsorship.service";
import { BudgetedFeePayment } from "./sponsorship-budget.service";

const FEE_PAYER = "11111111111111111111111111111111" as Address;
const BLOCKHASH = getBase58Codec().decode(new Uint8Array(32).fill(7)) as Blockhash;
const SCOPE: SponsorshipScope = {
  environment: "sandbox",
  organizationId: "org_1",
  projectId: "project_1",
  actor: { type: "api_key", id: "key_1" },
};

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

function harness() {
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
    signAsFeePayer: vi.fn().mockImplementation(async (transaction) => {
      const signed = transaction.slice();
      signed.fill(1, 1, 65);
      return signed;
    }),
    signAndSend: vi.fn().mockResolvedValue("signature_1" as Signature),
  };
  const feePayment = new BudgetedFeePayment({ SOLANA_NETWORK: "devnet" } as Env, SCOPE, provider, {
    repository,
    budgetRedis,
    getNetworkFee: vi.fn().mockResolvedValue(5_000n),
    now: () => new Date("2026-08-03T10:15:00.000Z"),
  });
  return { feePayment, provider, repository, budgetRedis };
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
      await expect(feePayment.signAndSend(buildTransaction(version))).resolves.toBe("signature_1");
      expect(repository.createReservation).toHaveBeenCalledOnce();
    }
  );

  it("commits the durable reservation before touching the Redis budget gate", async () => {
    const { feePayment, repository, budgetRedis } = harness();
    await expect(feePayment.signAndSend(buildTransaction())).resolves.toBe("signature_1");
    const created = repository.createReservation.mock.invocationCallOrder[0];
    const reserved = budgetRedis.reserve.mock.invocationCallOrder[0];
    expect(created).toBeLessThan(reserved);
  });

  it("excludes the current reservation from the reconstruction snapshot", async () => {
    const { feePayment, repository } = harness();
    await expect(feePayment.signAndSend(buildTransaction())).resolves.toBe("signature_1");
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

    await expect(feePayment.signAndSend(buildTransaction())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(budgetRedis.reserve).toHaveBeenCalledWith(expect.objectContaining({ amount: 5_000 }));
    expect(provider.signAndSend).not.toHaveBeenCalled();
    expect(repository.createReservation).toHaveBeenCalledOnce();
    expect(repository.markReleased).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "budget exceeded during admission"
    );
  });

  it("reserves network fee plus Kora outflow ceiling and denies before provider execution", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    const getSponsorshipConfiguration = provider.getSponsorshipConfiguration;
    if (!getSponsorshipConfiguration) throw new Error("test provider omitted configuration");
    vi.mocked(getSponsorshipConfiguration).mockResolvedValueOnce({
      signerAddress: FEE_PAYER,
      maxAllowedLamports: 1_000_000n,
      feePayerMayTransferLamports: true,
      feePayerPolicy: { system: { allow_transfer: true } },
    });
    repository.resolvePolicies.mockResolvedValueOnce([
      { ...policy("global"), perTransactionLamports: 1_000_000 },
      { ...policy("organization"), perTransactionLamports: 1_000_000 },
      { ...policy("project"), perTransactionLamports: 1_000_000 },
    ]);
    budgetRedis.reserve.mockImplementationOnce(async (input) =>
      input.amount > 1_000_000 ? "denied" : "admitted"
    );

    await expect(feePayment.signAndSend(buildTransaction())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(budgetRedis.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1_005_000 })
    );
    expect(provider.signAndSend).not.toHaveBeenCalled();
    expect(repository.createReservation).toHaveBeenCalledOnce();
    expect(repository.markReleased).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "budget exceeded during admission"
    );
  });

  it("retries the Redis gate under a refreshed policy without recreating the durable row", async () => {
    const { feePayment, repository, budgetRedis } = harness();
    budgetRedis.reserve.mockResolvedValueOnce("stale_policy");
    await expect(feePayment.signAndSend(buildTransaction())).resolves.toBe("signature_1");
    expect(budgetRedis.reserve).toHaveBeenCalledTimes(2);
    expect(repository.createReservation).toHaveBeenCalledOnce();
    expect(repository.markReleased).not.toHaveBeenCalled();
  });

  it("fails closed and releases once when the policy stays stale across both attempts", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    budgetRedis.reserve.mockResolvedValue("stale_policy");
    await expect(feePayment.signAndSend(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
    expect(budgetRedis.reserve).toHaveBeenCalledTimes(2);
    expect(repository.createReservation).toHaveBeenCalledOnce();
    expect(repository.markReleased).toHaveBeenCalledOnce();
    expect(provider.signAndSend).not.toHaveBeenCalled();
  });

  it("releases deterministic pre-send rejections", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    vi.mocked(provider.signAndSend).mockRejectedValueOnce(
      new FeePaymentError("rejected", "SIGNING_FAILED")
    );
    await expect(feePayment.signAndSend(buildTransaction())).rejects.toMatchObject({
      code: "SIGNING_FAILED",
    });
    expect(repository.markReleased).toHaveBeenCalledOnce();
    expect(repository.markReleased).toHaveBeenCalledWith(expect.any(String), 1, "rejected");
    expect(budgetRedis.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        actualLamports: 0,
        attempt: 1,
        detectMissingReservation: true,
      })
    );
    expect(budgetRedis.cancel).not.toHaveBeenCalled();
    expect(repository.markChargedUnknown).not.toHaveBeenCalled();
  });

  it("leaves a durable terminal-unsynced row when the Redis sync marker write fails", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    vi.mocked(provider.signAndSend).mockRejectedValueOnce(
      new FeePaymentError("rejected", "SIGNING_FAILED")
    );
    repository.markRedisSettled.mockRejectedValueOnce(new Error("postgres timeout"));
    await expect(feePayment.signAndSend(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
    expect(repository.markReleased).toHaveBeenCalledOnce();
    expect(budgetRedis.settle).toHaveBeenCalledOnce();
    expect(repository.tripGlobalBreaker).toHaveBeenCalled();
  });

  it("charges ambiguous submission timeouts conservatively", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    vi.mocked(provider.signAndSend).mockRejectedValueOnce(new Error("request timed out"));
    await expect(feePayment.signAndSend(buildTransaction())).rejects.toThrow("timed out");
    expect(repository.markChargedUnknown).toHaveBeenCalledOnce();
    expect(repository.markChargedUnknown).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "request timed out"
    );
    expect(repository.markReleased).not.toHaveBeenCalled();
    expect(budgetRedis.cancel).not.toHaveBeenCalled();
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
    await expect(feePayment.signAndSend(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
    expect(provider.signAndSend).not.toHaveBeenCalled();
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
    await expect(feePayment.signAndSend(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
    expect(provider.signAndSend).not.toHaveBeenCalled();
    expect(budgetRedis.cancel).not.toHaveBeenCalled();
    expect(repository.tripGlobalBreaker).not.toHaveBeenCalled();
  });

  it("does not open the breaker when reconciliation already committed a slow submission", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    repository.markSubmitted.mockResolvedValue("stale");
    repository.getReservation.mockResolvedValueOnce(null).mockResolvedValue({
      id: "reservation_1",
      status: "committed",
      signature: "signature_1",
      signedTransaction: null,
      reservedLamports: 5_000,
      actualLamports: 5_000,
      attempt: 1,
    });
    await expect(feePayment.signAndSend(buildTransaction())).resolves.toBe("signature_1");
    expect(provider.signAndSend).toHaveBeenCalledOnce();
    expect(repository.tripGlobalBreaker).not.toHaveBeenCalled();
    expect(budgetRedis.cancel).not.toHaveBeenCalled();
  });

  it("releases the racing reservation instead of tripping the breaker on a duplicate signature", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    repository.markSubmitted.mockResolvedValue("duplicate_signature");
    await expect(feePayment.signAndSend(buildTransaction())).resolves.toBe("signature_1");
    expect(provider.signAndSend).toHaveBeenCalledOnce();
    expect(repository.markReleased).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "Transaction already sponsored under another reservation"
    );
    expect(budgetRedis.settle).toHaveBeenCalled();
    expect(repository.tripGlobalBreaker).not.toHaveBeenCalled();
  });

  it("does not open the breaker when reconciliation already charged the in-flight reservation as unknown", async () => {
    const { feePayment, provider, repository } = harness();
    repository.markSubmitted.mockResolvedValue("stale");
    repository.getReservation.mockResolvedValueOnce(null).mockResolvedValue({
      id: "reservation_1",
      status: "charged_unknown",
      signature: "signature_1",
      signedTransaction: null,
      reservedLamports: 5_000,
      actualLamports: null,
      attempt: 1,
    });
    await expect(feePayment.signAndSend(buildTransaction())).resolves.toBe("signature_1");
    expect(provider.signAndSend).toHaveBeenCalledOnce();
    expect(repository.tripGlobalBreaker).not.toHaveBeenCalled();
  });

  it("still opens the breaker when a lost submission did not advance on-chain", async () => {
    const { feePayment, repository } = harness();
    repository.markSubmitted.mockResolvedValue("stale");
    repository.getReservation.mockResolvedValueOnce(null).mockResolvedValue({
      id: "reservation_1",
      status: "released",
      signature: null,
      signedTransaction: null,
      reservedLamports: 5_000,
      actualLamports: 0,
      attempt: 1,
    });
    await expect(feePayment.signAndSend(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
    expect(repository.tripGlobalBreaker).toHaveBeenCalled();
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

  it("does not promote a signed reservation to submission after a kill", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    const transaction = buildTransaction();
    repository.getReservation
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "reservation_1",
        status: "signed",
        signature: null,
        signedTransaction: Buffer.from(transaction).toString("base64"),
        reservedLamports: 5_000,
        actualLamports: null,
        attempt: 1,
      });
    await feePayment.signAsFeePayer(transaction);
    repository.resolvePolicies.mockResolvedValueOnce([
      policy("global", false),
      policy("organization"),
      policy("project"),
    ]);
    await expect(feePayment.signAndSend(transaction)).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
    expect(provider.signAndSend).not.toHaveBeenCalled();
    expect(budgetRedis.reserve).toHaveBeenCalledOnce();
  });

  it("never mistakes a sign-only signature for a broadcast send result", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    const signedOnly = {
      id: "reservation_1",
      status: "signed" as const,
      signature: "signed_but_not_sent",
      signedTransaction: Buffer.from(buildTransaction()).toString("base64"),
      reservedLamports: 5_000,
      actualLamports: null,
      attempt: 1,
    };
    repository.getReservation.mockResolvedValue(signedOnly);
    budgetRedis.reserve.mockResolvedValueOnce("duplicate");
    await expect(feePayment.signAndSend(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
    expect(provider.signAndSend).not.toHaveBeenCalled();
  });

  it("maps uncertain Kora and RPC preflight failures to service unavailable", async () => {
    const { feePayment, provider, repository } = harness();
    const getConfig = provider.getSponsorshipConfiguration;
    if (!getConfig) throw new Error("Expected sponsorship configuration capability");
    vi.mocked(getConfig).mockRejectedValueOnce(new Error("offline"));
    await expect(feePayment.signAndSend(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
    expect(repository.createReservation).not.toHaveBeenCalled();
    expect(provider.signAndSend).not.toHaveBeenCalled();
  });

  it("opens the breaker and returns 503 when durable usage reconstruction fails", async () => {
    const { feePayment, provider, repository } = harness();
    repository.loadWindowAdmissionSnapshot.mockRejectedValueOnce(new Error("postgres unavailable"));
    await expect(feePayment.signAndSend(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
    expect(repository.tripGlobalBreaker).toHaveBeenCalledWith(
      "devnet",
      "Budget reconstruction or Redis admission failed"
    );
    expect(provider.signAndSend).not.toHaveBeenCalled();
  });

  it("fails closed without touching Redis when durable reservation persistence fails", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    repository.createReservation.mockRejectedValueOnce(new Error("postgres unavailable"));
    await expect(feePayment.signAndSend(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
    expect(budgetRedis.reserve).not.toHaveBeenCalled();
    expect(budgetRedis.cancel).not.toHaveBeenCalled();
    expect(repository.tripGlobalBreaker).toHaveBeenCalled();
    expect(provider.signAndSend).not.toHaveBeenCalled();
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

    await expect(feePayment.signAndSend(buildTransaction())).resolves.toBe("signature_1");

    expect(budgetRedis.reserve).toHaveBeenCalledWith(expect.objectContaining({ attempt: 2 }));
    expect(repository.createReservation).not.toHaveBeenCalled();
    expect(repository.reopenReleasedReservation).toHaveBeenCalledWith(expect.any(Object), 1);
    expect(repository.markSubmitted).toHaveBeenCalledWith(expect.any(String), 2, "signature_1");
  });

  it("fails closed when a stale provider callback loses ownership to a retry", async () => {
    const { feePayment, repository, budgetRedis } = harness();
    repository.markSubmitted.mockResolvedValueOnce("stale");

    await expect(feePayment.signAndSend(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });

    expect(repository.markSubmitted).toHaveBeenCalledWith(expect.any(String), 1, "signature_1");
    expect(repository.tripGlobalBreaker).toHaveBeenCalledWith(
      "devnet",
      "Submitted sponsorship outcome lost its durable state transition"
    );
    expect(budgetRedis.settle).not.toHaveBeenCalled();
  });

  it("does not let a stale deterministic failure release a newer attempt", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    vi.mocked(provider.signAndSend).mockRejectedValueOnce(
      new FeePaymentError("stale rejection", "SIGNING_FAILED")
    );
    repository.markReleased.mockResolvedValueOnce(false);

    await expect(feePayment.signAndSend(buildTransaction())).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });

    expect(repository.markReleased).toHaveBeenCalledWith(expect.any(String), 1, "stale rejection");
    expect(budgetRedis.settle).not.toHaveBeenCalled();
    expect(repository.markRedisSettled).not.toHaveBeenCalled();
  });
});

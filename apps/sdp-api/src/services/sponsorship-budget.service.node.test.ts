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

function buildTransaction(): Uint8Array {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
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
    getWindowUsage: vi.fn().mockResolvedValue({
      hour: { global: 0, organization: 0, project: 0 },
      day: { global: 0, organization: 0, project: 0 },
    }),
    getReservation: vi.fn().mockResolvedValue(null),
    createReservation: vi.fn().mockResolvedValue(true),
    reopenReleasedReservation: vi.fn().mockResolvedValue(false),
    markSigned: vi.fn().mockResolvedValue(undefined),
    markSubmitted: vi.fn().mockResolvedValue(undefined),
    markChargedUnknown: vi.fn().mockResolvedValue(undefined),
    markReleased: vi.fn().mockResolvedValue(undefined),
    tripGlobalBreaker: vi.fn().mockResolvedValue(null),
  };
  const budgetRedis = {
    reserve: vi.fn().mockResolvedValue("admitted" as const),
    cancel: vi.fn().mockResolvedValue(undefined),
    syncPolicy: vi.fn().mockResolvedValue(undefined),
  };
  const provider: FeePaymentPort = {
    providerId: "kora",
    getFeePayer: vi.fn().mockResolvedValue(FEE_PAYER),
    getSponsorshipConfiguration: vi.fn().mockResolvedValue({
      signerAddress: FEE_PAYER,
      maxAllowedLamports: 1_000_000n,
      feePayerMayTransferLamports: false,
    }),
    signAsFeePayer: vi.fn().mockImplementation(async (transaction) => transaction),
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

  it("releases deterministic pre-send rejections", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    vi.mocked(provider.signAndSend).mockRejectedValueOnce(
      new FeePaymentError("rejected", "SIGNING_FAILED")
    );
    await expect(feePayment.signAndSend(buildTransaction())).rejects.toMatchObject({
      code: "SIGNING_FAILED",
    });
    expect(repository.markReleased).toHaveBeenCalledOnce();
    expect(budgetRedis.cancel).toHaveBeenCalledOnce();
    expect(repository.markChargedUnknown).not.toHaveBeenCalled();
  });

  it("charges ambiguous submission timeouts conservatively", async () => {
    const { feePayment, provider, repository, budgetRedis } = harness();
    vi.mocked(provider.signAndSend).mockRejectedValueOnce(new Error("request timed out"));
    await expect(feePayment.signAndSend(buildTransaction())).rejects.toThrow("timed out");
    expect(repository.markChargedUnknown).toHaveBeenCalledOnce();
    expect(repository.markReleased).not.toHaveBeenCalled();
    expect(budgetRedis.cancel).not.toHaveBeenCalled();
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
});

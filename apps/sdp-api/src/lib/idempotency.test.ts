import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import {
  buildEarnVaultDepositFingerprint,
  buildEarnVaultDepositIntentFingerprint,
  buildPaymentTransferFingerprint,
  buildTransferBatchFingerprint,
  normalizeForFingerprint,
  resolveIdempotencyReplay,
  resolveIdentityBoundIdempotencyReplay,
} from "./idempotency";

describe("buildEarnVaultDepositFingerprint", () => {
  const base = {
    environment: "sandbox",
    provider: "kamino",
    providerReference: "vault_1",
    custodyWalletId: "cwlt_1",
    amount: "1",
    minSharesOut: "0.5",
  };

  it("normalizes insignificant decimal zeroes without rounding", () => {
    expect(buildEarnVaultDepositFingerprint(base)).toBe(
      buildEarnVaultDepositFingerprint({
        ...base,
        amount: "0001.000000",
        minSharesOut: "00.5000",
      })
    );
  });

  it("keeps different exact decimal magnitudes distinct", () => {
    expect(buildEarnVaultDepositFingerprint(base)).not.toBe(
      buildEarnVaultDepositFingerprint({ ...base, amount: "1.000001" })
    );
  });
});

describe("buildEarnVaultDepositIntentFingerprint", () => {
  const base = {
    organizationId: "org_1",
    projectId: "prj_1",
    environment: "sandbox",
    provider: "kamino",
    providerReference: "vault_1",
    custodyWalletId: "cwlt_1",
    tokenMint: "mint_token",
    shareMint: "mint_share",
    amount: "1",
  };

  /**
   * The cross-key claim's key: two tabs submitting the same unchanged intent
   * must land on ONE claim even when they re-quoted at different moments, so
   * the quote-derived floor must never enter this fingerprint. The input type
   * already refuses to carry it; this pins the serialized shape against a
   * future field sneaking back in under a permissive name.
   */
  it("carries no quote-derived floor material", () => {
    expect(buildEarnVaultDepositIntentFingerprint(base)).not.toContain("minSharesOut");
    expect(buildEarnVaultDepositIntentFingerprint(base)).not.toContain("swapSlippageBps");
  });

  it("normalizes insignificant decimal zeroes without rounding", () => {
    expect(buildEarnVaultDepositIntentFingerprint(base)).toBe(
      buildEarnVaultDepositIntentFingerprint({ ...base, amount: "0001.000000" })
    );
  });

  it("differs when any intent-scoping field changes", () => {
    const variants = [
      { ...base, organizationId: "org_2" },
      { ...base, projectId: "prj_2" },
      { ...base, environment: "production" },
      { ...base, provider: "veda" },
      { ...base, providerReference: "vault_2" },
      { ...base, custodyWalletId: "cwlt_2" },
      { ...base, tokenMint: "mint_other" },
      { ...base, shareMint: "mint_other" },
      { ...base, amount: "2" },
      { ...base, swapSourceTokenMint: "mint_usdt" },
    ];
    for (const variant of variants) {
      expect(buildEarnVaultDepositIntentFingerprint(base)).not.toBe(
        buildEarnVaultDepositIntentFingerprint(variant)
      );
    }
  });
});

describe("resolveIdempotencyReplay", () => {
  it("returns null when no row has claimed the key", async () => {
    expect(await resolveIdempotencyReplay(async () => null, "fp")).toBeNull();
  });

  it("returns the existing row when its fingerprint matches", async () => {
    const row = { id: "row_1", idempotency_fingerprint: "fp" };
    expect(await resolveIdempotencyReplay(async () => row, "fp")).toBe(row);
  });

  it("treats a stored row without a fingerprint as unclaimed", async () => {
    const row = { id: "row_1", idempotency_fingerprint: null };
    expect(await resolveIdempotencyReplay(async () => row, "fp")).toBeNull();
  });

  it("throws CONFLICT when the fingerprint differs", async () => {
    const row = { id: "row_1", idempotency_fingerprint: "other" };
    await expect(resolveIdempotencyReplay(async () => row, "fp")).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.code === "CONFLICT"
    );
  });
});

describe("resolveIdentityBoundIdempotencyReplay", () => {
  const row = { id: "row_1", idempotency_fingerprint: "current", custody_wallet_id: "cwlt_1" };

  it("accepts a matching fingerprint only for the requested exact wallet", async () => {
    expect(
      await resolveIdentityBoundIdempotencyReplay(
        async () => row,
        "current",
        (existing) => existing.custody_wallet_id === "cwlt_1"
      )
    ).toBe(row);
  });

  it("rejects a fingerprint match when the persisted exact wallet differs", async () => {
    await expect(
      resolveIdentityBoundIdempotencyReplay(
        async () => row,
        "current",
        (existing) => existing.custody_wallet_id === "cwlt_2"
      )
    ).rejects.toSatisfy((error: unknown) => error instanceof AppError && error.code === "CONFLICT");
  });
});

describe("normalizeForFingerprint", () => {
  it("orders object keys deterministically and drops undefined", () => {
    const a = normalizeForFingerprint({ b: 1, a: 2, c: undefined });
    const b = normalizeForFingerprint({ a: 2, b: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("buildPaymentTransferFingerprint", () => {
  const base = {
    custodyWalletId: "cwlt_source_1",
    sourceAddress: "Src",
    destinationAddress: "Dst",
    token: "SOL",
    amount: "1",
    memo: null,
    type: "transfer",
  };

  it("is stable regardless of input key order", () => {
    expect(buildPaymentTransferFingerprint(base)).toBe(
      buildPaymentTransferFingerprint({
        type: "transfer",
        memo: null,
        amount: "1",
        token: "SOL",
        destinationAddress: "Dst",
        sourceAddress: "Src",
        custodyWalletId: "cwlt_source_1",
      })
    );
  });

  it("differs when the exact SDP Wallet ID changes", () => {
    expect(buildPaymentTransferFingerprint(base)).not.toBe(
      buildPaymentTransferFingerprint({ ...base, custodyWalletId: "cwlt_source_2" })
    );
  });

  it("differs when a money-relevant field changes", () => {
    expect(buildPaymentTransferFingerprint(base)).not.toBe(
      buildPaymentTransferFingerprint({ ...base, amount: "2" })
    );
  });
});

describe("buildTransferBatchFingerprint", () => {
  const firstRecipient = {
    externalId: "recipient-1",
    counterpartyId: "counterparty-1",
    counterpartyAccountId: "account-1",
    destinationAddress: "Destination111",
    amount: "1.5",
  };
  const secondRecipient = {
    externalId: null,
    counterpartyId: "counterparty-2",
    counterpartyAccountId: "account-2",
    destinationAddress: "Destination222",
    amount: "2",
  };

  it("is stable regardless of input key order", () => {
    expect(
      buildTransferBatchFingerprint({
        sourceCustodyWalletId: "cwlt_source_1",
        sourceAddress: "Source111",
        token: "SOL",
        recipients: [firstRecipient, secondRecipient],
        options: { preflight: false },
      })
    ).toBe(
      buildTransferBatchFingerprint({
        sourceCustodyWalletId: "cwlt_source_1",
        options: { preflight: false },
        recipients: [firstRecipient, secondRecipient],
        token: "SOL",
        sourceAddress: "Source111",
      })
    );
  });

  it("differs when the exact SDP Wallet ID changes", () => {
    expect(
      buildTransferBatchFingerprint({
        sourceCustodyWalletId: "cwlt_source_1",
        sourceAddress: "Source111",
        token: "SOL",
        recipients: [firstRecipient],
        options: undefined,
      })
    ).not.toBe(
      buildTransferBatchFingerprint({
        sourceCustodyWalletId: "cwlt_source_2",
        sourceAddress: "Source111",
        token: "SOL",
        recipients: [firstRecipient],
        options: undefined,
      })
    );
  });

  it("preserves recipient order", () => {
    expect(
      buildTransferBatchFingerprint({
        sourceCustodyWalletId: "cwlt_source_1",
        sourceAddress: "Source111",
        token: "SOL",
        recipients: [firstRecipient, secondRecipient],
        options: undefined,
      })
    ).not.toBe(
      buildTransferBatchFingerprint({
        sourceCustodyWalletId: "cwlt_source_1",
        sourceAddress: "Source111",
        token: "SOL",
        recipients: [secondRecipient, firstRecipient],
        options: undefined,
      })
    );
  });

  it("normalizes option keys", () => {
    expect(
      buildTransferBatchFingerprint({
        sourceCustodyWalletId: "cwlt_source_1",
        sourceAddress: "Source111",
        token: "SOL",
        recipients: [firstRecipient],
        options: { maxRecipientsPerTransaction: 10, preflight: false },
      })
    ).toBe(
      buildTransferBatchFingerprint({
        sourceCustodyWalletId: "cwlt_source_1",
        sourceAddress: "Source111",
        token: "SOL",
        recipients: [firstRecipient],
        options: { preflight: false, maxRecipientsPerTransaction: 10 },
      })
    );
  });
});

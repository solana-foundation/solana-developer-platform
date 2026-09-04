import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import {
  buildEarnVaultDepositFingerprint,
  buildLegacyPaymentTransferFingerprint,
  buildLegacyTransferBatchFingerprint,
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
  const row = { id: "row_1", idempotency_fingerprint: "legacy", custody_wallet_id: "cwlt_1" };

  it("accepts a complete legacy fingerprint only for the requested exact wallet", async () => {
    expect(
      await resolveIdentityBoundIdempotencyReplay(
        async () => row,
        "current",
        "legacy",
        (existing) => existing.custody_wallet_id === "cwlt_1"
      )
    ).toBe(row);
  });

  it("rejects a fingerprint match when the persisted exact wallet differs", async () => {
    await expect(
      resolveIdentityBoundIdempotencyReplay(
        async () => row,
        "current",
        "legacy",
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

  it("keeps the pre-K3 fingerprint available for compatible legacy replay", () => {
    expect(buildLegacyPaymentTransferFingerprint(base)).toBe(
      '{"amount":"1","destinationAddress":"Dst","memo":null,"privateTransfer":null,"scope":"payment_transfer","sourceAddress":"Src","token":"SOL","type":"transfer"}'
    );
  });

  it("differs when a money-relevant field changes", () => {
    expect(buildPaymentTransferFingerprint(base)).not.toBe(
      buildPaymentTransferFingerprint({ ...base, amount: "2" })
    );
  });

  it("differs when private transfer options differ", () => {
    const base = {
      custodyWalletId: "cwlt_source_1",
      sourceAddress: "Src",
      destinationAddress: "Dst",
      token: "SOL",
      amount: "1",
      memo: null,
      type: "transfer_confidential",
    };
    expect(
      buildPaymentTransferFingerprint({ ...base, privateTransfer: { magicBlock: { split: 2 } } })
    ).not.toBe(
      buildPaymentTransferFingerprint({ ...base, privateTransfer: { magicBlock: { split: 3 } } })
    );
  });

  it("is stable for identical private transfer options regardless of key order", () => {
    const base = {
      custodyWalletId: "cwlt_source_1",
      sourceAddress: "Src",
      destinationAddress: "Dst",
      token: "SOL",
      amount: "1",
      memo: null,
      type: "transfer_confidential",
    };
    expect(
      buildPaymentTransferFingerprint({
        ...base,
        privateTransfer: { magicBlock: { split: 2, gasless: true } },
      })
    ).toBe(
      buildPaymentTransferFingerprint({
        ...base,
        privateTransfer: { magicBlock: { gasless: true, split: 2 } },
      })
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

  it("keeps the pre-K3 fingerprint available for compatible legacy replay", () => {
    expect(
      buildLegacyTransferBatchFingerprint({
        sourceCustodyWalletId: "cwlt_source_1",
        sourceAddress: "Source111",
        token: "SOL",
        recipients: [firstRecipient],
        options: undefined,
      })
    ).toBe(
      '{"options":null,"recipients":[{"amount":"1.5","counterpartyAccountId":"account-1","counterpartyId":"counterparty-1","destinationAddress":"Destination111","externalId":"recipient-1"}],"scope":"payment_transfer_batch","sourceAddress":"Source111","token":"SOL"}'
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

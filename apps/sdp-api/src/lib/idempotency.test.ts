import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import {
  buildPaymentTransferFingerprint,
  buildTransferBatchFingerprint,
  normalizeForFingerprint,
  resolveIdempotencyReplay,
} from "./idempotency";

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

describe("normalizeForFingerprint", () => {
  it("orders object keys deterministically and drops undefined", () => {
    const a = normalizeForFingerprint({ b: 1, a: 2, c: undefined });
    const b = normalizeForFingerprint({ a: 2, b: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("buildPaymentTransferFingerprint", () => {
  const base = {
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
      })
    );
  });

  it("differs when a money-relevant field changes", () => {
    expect(buildPaymentTransferFingerprint(base)).not.toBe(
      buildPaymentTransferFingerprint({ ...base, amount: "2" })
    );
  });

  it("differs when the counterparty changes", () => {
    expect(buildPaymentTransferFingerprint({ ...base, counterpartyId: "cp_1" })).not.toBe(
      buildPaymentTransferFingerprint({ ...base, counterpartyId: "cp_2" })
    );
  });

  it("differs when private transfer options differ", () => {
    const base = {
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
        sourceAddress: "Source111",
        token: "SOL",
        recipients: [firstRecipient, secondRecipient],
        options: { preflight: false },
      })
    ).toBe(
      buildTransferBatchFingerprint({
        options: { preflight: false },
        recipients: [firstRecipient, secondRecipient],
        token: "SOL",
        sourceAddress: "Source111",
      })
    );
  });

  it("preserves recipient order", () => {
    expect(
      buildTransferBatchFingerprint({
        sourceAddress: "Source111",
        token: "SOL",
        recipients: [firstRecipient, secondRecipient],
        options: undefined,
      })
    ).not.toBe(
      buildTransferBatchFingerprint({
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
        sourceAddress: "Source111",
        token: "SOL",
        recipients: [firstRecipient],
        options: { maxRecipientsPerTransaction: 10, preflight: false },
      })
    ).toBe(
      buildTransferBatchFingerprint({
        sourceAddress: "Source111",
        token: "SOL",
        recipients: [firstRecipient],
        options: { preflight: false, maxRecipientsPerTransaction: 10 },
      })
    );
  });
});

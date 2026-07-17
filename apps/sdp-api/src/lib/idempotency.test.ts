import { describe, expect, it } from "vitest";
import {
  buildPaymentTransferFingerprint,
  buildTransferBatchFingerprint,
  normalizeForFingerprint,
} from "./idempotency";

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

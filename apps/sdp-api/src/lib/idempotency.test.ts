import { describe, expect, it } from "vitest";
import { buildPaymentTransferFingerprint, normalizeForFingerprint } from "./idempotency";

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

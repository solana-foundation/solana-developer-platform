import { describe, expect, it } from "vitest";
import { canonicalizeTransferBatchBody } from "./idempotency";

describe("canonicalizeTransferBatchBody", () => {
  it("makes recipient order irrelevant and keeps everything else as sent", () => {
    const a = { counterpartyId: "cp_a", amount: "1" };
    const b = { counterpartyId: "cp_b", amount: "2" };
    const body = { sourceCustodyWalletId: "cwlt_1", token: "SOL", recipients: [b, a] };

    expect(canonicalizeTransferBatchBody(body)).toEqual({ ...body, recipients: [a, b] });
    expect(canonicalizeTransferBatchBody({ ...body, recipients: [a, b] })).toEqual(
      canonicalizeTransferBatchBody(body)
    );
  });

  it("leaves a body without a recipients array untouched for validation to refuse", () => {
    expect(canonicalizeTransferBatchBody({ recipients: "nope" })).toEqual({ recipients: "nope" });
    expect(canonicalizeTransferBatchBody(["unparsed", "{"])).toEqual(["unparsed", "{"]);
  });
});

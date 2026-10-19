import { describe, expect, it } from "vitest";
import { canonicalizeTransferBatchBody, previousCanonicalTransferBatchBody } from "./idempotency";

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

  it("spells recipient amounts canonically and drops empty options", () => {
    const body = {
      sourceCustodyWalletId: "cwlt_1",
      token: "SOL",
      recipients: [{ counterpartyAccountId: "cpa_a", amount: "1" }],
    };
    const respelled = {
      ...body,
      options: {},
      recipients: [{ counterpartyAccountId: "cpa_a", amount: "01.000" }],
    };

    expect(canonicalizeTransferBatchBody(respelled)).toEqual(canonicalizeTransferBatchBody(body));
    expect(canonicalizeTransferBatchBody({ ...body, options: { preflight: false } })).toEqual({
      ...body,
      options: { preflight: false },
    });
  });

  it("treats options sent at their default as omitted (APE-665)", () => {
    const body = {
      sourceCustodyWalletId: "cwlt_1",
      token: "SOL",
      recipients: [{ counterpartyAccountId: "cpa_a", amount: "1" }],
    };

    expect(
      canonicalizeTransferBatchBody({
        ...body,
        options: { maxRecipientsPerTransaction: 20, preflight: true },
      })
    ).toEqual(canonicalizeTransferBatchBody(body));
    expect(
      canonicalizeTransferBatchBody({
        ...body,
        options: { maxRecipientsPerTransaction: 20, preflight: false },
      })
    ).toEqual({ ...body, options: { preflight: false } });
    expect(
      canonicalizeTransferBatchBody({ ...body, options: { maxRecipientsPerTransaction: 8 } })
    ).toEqual({ ...body, options: { maxRecipientsPerTransaction: 8 } });
  });

  it("keeps the pre-APE-665 form, options as sent, for keys saved before it", () => {
    const body = {
      sourceCustodyWalletId: "cwlt_1",
      token: "SOL",
      recipients: [{ counterpartyAccountId: "cpa_a", amount: "1.0" }],
      options: { maxRecipientsPerTransaction: 20 },
    };
    expect(previousCanonicalTransferBatchBody(body)).toEqual({
      ...body,
      recipients: [{ counterpartyAccountId: "cpa_a", amount: "1" }],
    });
    expect(previousCanonicalTransferBatchBody(body)).not.toEqual(
      canonicalizeTransferBatchBody(body)
    );
  });

  it("leaves a body without a recipients array untouched for validation to refuse", () => {
    expect(canonicalizeTransferBatchBody({ recipients: "nope" })).toEqual({ recipients: "nope" });
    expect(canonicalizeTransferBatchBody(["unparsed", "{"])).toEqual(["unparsed", "{"]);
  });
});

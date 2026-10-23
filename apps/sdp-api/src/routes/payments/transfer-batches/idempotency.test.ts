import { runInClusterScope } from "@sdp/rpc/scope";
import { SOL_MINT, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@/lib/idempotency";
import {
  canonicalizeTransferBatchBody as canonicalizeOnDevnet,
  PREVIOUS_TRANSFER_BATCH_FORMS,
} from "./idempotency";

/** Runs `form` as a sandbox project's request does: its tokens resolve on devnet. */
function onDevnet(form: (body: JsonValue) => JsonValue): (body: JsonValue) => JsonValue {
  return (body) => runInClusterScope({ projectId: null, environment: "sandbox" }, () => form(body));
}

const canonicalizeTransferBatchBody = onDevnet(canonicalizeOnDevnet);
const [beforeAdr0012, beforeApe665] = PREVIOUS_TRANSFER_BATCH_FORMS.map(onDevnet);

const USDC = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;
const BODY = {
  sourceCustodyWalletId: "cwlt_1",
  recipients: [{ counterpartyAccountId: "cpa_a", amount: "1" }],
};

describe("canonicalizeTransferBatchBody", () => {
  it("makes recipient order irrelevant and spells the token as the asset", () => {
    const a = { counterpartyId: "cp_a", amount: "1" };
    const b = { counterpartyId: "cp_b", amount: "2" };
    const body = { sourceCustodyWalletId: "cwlt_1", token: USDC, recipients: [b, a] };

    expect(canonicalizeTransferBatchBody(body)).toEqual({
      sourceCustodyWalletId: "cwlt_1",
      asset: USDC,
      recipients: [a, b],
    });
    expect(canonicalizeTransferBatchBody({ ...body, recipients: [a, b] })).toEqual(
      canonicalizeTransferBatchBody(body)
    );
  });

  it("spells recipient amounts canonically and drops empty options", () => {
    const body = { ...BODY, token: USDC };
    const respelled = {
      ...body,
      options: {},
      recipients: [{ counterpartyAccountId: "cpa_a", amount: "01.000" }],
    };

    expect(canonicalizeTransferBatchBody(respelled)).toEqual(canonicalizeTransferBatchBody(body));
    expect(canonicalizeTransferBatchBody({ ...body, options: { preflight: false } })).toEqual({
      ...BODY,
      asset: USDC,
      options: { preflight: false },
    });
  });

  it("treats options sent at their default as omitted (APE-665)", () => {
    const body = { ...BODY, token: USDC };

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
    ).toEqual({ ...BODY, asset: USDC, options: { preflight: false } });
    expect(
      canonicalizeTransferBatchBody({ ...body, options: { maxRecipientsPerTransaction: 8 } })
    ).toEqual({ ...BODY, asset: USDC, options: { maxRecipientsPerTransaction: 8 } });
  });

  it("treats an omitted priority fee as none (APE SOLA9-765)", () => {
    const body = { ...BODY, token: USDC };

    expect(canonicalizeTransferBatchBody({ ...body, options: { priorityFee: "none" } })).toEqual(
      canonicalizeTransferBatchBody(body)
    );
    expect(canonicalizeTransferBatchBody({ ...body, options: { priorityFee: "high" } })).toEqual({
      ...BODY,
      asset: USDC,
      options: { priorityFee: "high" },
    });
  });

  it("fingerprints a symbol and its mint as one asset, and refuses wrapped SOL (APE SOLA9-695)", () => {
    expect(canonicalizeTransferBatchBody({ ...BODY, token: "usdc" })).toEqual(
      canonicalizeTransferBatchBody({ ...BODY, token: USDC })
    );
    // ADR 0012: "SOL" moves native SOL; rows store it under the wrapped SOL mint, which is refused.
    expect(canonicalizeTransferBatchBody({ ...BODY, token: "sol" })).toEqual({
      ...BODY,
      asset: "native",
    });
    expect(() => canonicalizeTransferBatchBody({ ...BODY, token: SOL_MINT })).toThrow(
      'Payments does not move wrapped SOL: send token "SOL" to move native SOL'
    );
  });

  it("keeps both earlier forms, so a key or row saved under either still matches", () => {
    const body = {
      ...BODY,
      token: "sol",
      recipients: [{ counterpartyAccountId: "cpa_a", amount: "1.0" }],
      options: { maxRecipientsPerTransaction: 20 },
    };

    // Before ADR 0012: defaults dropped, the token as the mint it executed as.
    expect(beforeAdr0012(body)).toEqual({ ...BODY, token: SOL_MINT });
    expect(beforeAdr0012({ ...body, token: SOL_MINT })).toEqual(beforeAdr0012(body));
    // Before APE-665: options and token as sent.
    expect(beforeApe665(body)).toEqual({
      ...BODY,
      token: "sol",
      options: { maxRecipientsPerTransaction: 20 },
    });
  });

  it("leaves a body without a recipients array untouched for validation to refuse", () => {
    expect(canonicalizeTransferBatchBody({ recipients: "nope" })).toEqual({ recipients: "nope" });
    expect(canonicalizeTransferBatchBody(["unparsed", "{"])).toEqual(["unparsed", "{"]);
  });
});

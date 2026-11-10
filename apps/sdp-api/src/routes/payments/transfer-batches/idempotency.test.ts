import { runInClusterScope } from "@sdp/rpc/scope";
import { SOL_MINT, wellKnownMint } from "@sdp/types/well-known-tokens";
import { describe, expect, it } from "vitest";
import { canonicalizeTransferBatchBody, previousCanonicalTransferBatchBody } from "./idempotency";

describe("canonicalizeTransferBatchBody", () => {
  it("makes recipient order irrelevant and keeps everything else as sent", () => {
    const a = { counterpartyId: "cp_a", amount: "1" };
    const b = { counterpartyId: "cp_b", amount: "2" };
    const body = { sourceCustodyWalletId: "cwlt_1", token: SOL_MINT, recipients: [b, a] };

    expect(canonicalizeTransferBatchBody(body)).toEqual({ ...body, recipients: [a, b] });
    expect(canonicalizeTransferBatchBody({ ...body, recipients: [a, b] })).toEqual(
      canonicalizeTransferBatchBody(body)
    );
  });

  it("spells recipient amounts canonically", () => {
    const body = {
      sourceCustodyWalletId: "cwlt_1",
      token: SOL_MINT,
      recipients: [{ counterpartyAccountId: "cpa_a", amount: "1" }],
    };
    const respelled = {
      ...body,
      recipients: [{ counterpartyAccountId: "cpa_a", amount: "01.000" }],
    };

    expect(canonicalizeTransferBatchBody(respelled)).toEqual(canonicalizeTransferBatchBody(body));
  });

  it("fingerprints the token as the mint the batch executes as (APE SOLA9-695)", () => {
    const usdc = wellKnownMint("USDC", "devnet");
    const body = {
      sourceCustodyWalletId: "cwlt_1",
      recipients: [{ counterpartyAccountId: "cpa_a", amount: "1" }],
    };

    runInClusterScope({ projectId: null, environment: "sandbox" }, () => {
      expect(canonicalizeTransferBatchBody({ ...body, token: "usdc" })).toEqual(
        canonicalizeTransferBatchBody({ ...body, token: usdc ?? "" })
      );
      expect(canonicalizeTransferBatchBody({ ...body, token: "SOL" })).toEqual(
        canonicalizeTransferBatchBody({ ...body, token: SOL_MINT })
      );
    });
  });

  it("keeps the token as sent in the previous form, for keys saved under it", () => {
    const body = {
      sourceCustodyWalletId: "cwlt_1",
      token: "SOL",
      recipients: [{ counterpartyAccountId: "cpa_a", amount: "1.0" }],
    };
    expect(previousCanonicalTransferBatchBody(body)).toEqual({
      ...body,
      recipients: [{ counterpartyAccountId: "cpa_a", amount: "1" }],
    });
    expect(previousCanonicalTransferBatchBody(body)).not.toEqual(
      canonicalizeTransferBatchBody(body)
    );
  });

  it("leaves what is not a recipient untouched for validation to refuse", () => {
    const body = { token: SOL_MINT, recipients: [], options: {} };
    expect(canonicalizeTransferBatchBody(body)).toEqual(body);
    expect(canonicalizeTransferBatchBody({ recipients: "nope" })).toEqual({ recipients: "nope" });
    expect(canonicalizeTransferBatchBody(["unparsed", "{"])).toEqual(["unparsed", "{"]);
  });
});

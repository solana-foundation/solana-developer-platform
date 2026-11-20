import { runInClusterScope } from "@sdp/rpc/scope";
import { SOL_MINT, WELL_KNOWN_TOKENS, wellKnownMint } from "@sdp/types/well-known-tokens";
import { describe, expect, it } from "vitest";
import { required } from "@/test/helpers/required";
import { canonicalizeTransferBatchBody, previousCanonicalTransferBatchBody } from "./idempotency";

const A = { counterpartyId: "cp_a", counterpartyAccountId: "cpa_a", amount: "1" };
const B = { counterpartyId: "cp_b", counterpartyAccountId: "cpa_b", amount: "2" };
const BATCH = { sourceCustodyWalletId: "cwlt_1", token: SOL_MINT, recipients: [A, B] };

describe("canonicalizeTransferBatchBody", () => {
  it("fingerprints a reordered batch as the same request", () => {
    expect(canonicalizeTransferBatchBody({ ...BATCH, recipients: [B, A] })).toEqual(
      canonicalizeTransferBatchBody(BATCH)
    );
  });

  it("fingerprints a re-spelled amount as the same request", () => {
    const respelled = { ...BATCH, recipients: [{ ...A, amount: "01.000" }, B] };

    expect(canonicalizeTransferBatchBody(respelled)).toEqual(canonicalizeTransferBatchBody(BATCH));
  });

  it("fingerprints a token symbol as the mint the batch executes as", () => {
    const usdc = required(wellKnownMint("USDC", "devnet"));

    runInClusterScope({ projectId: null, environment: "sandbox" }, () => {
      expect(
        canonicalizeTransferBatchBody({
          ...BATCH,
          token: WELL_KNOWN_TOKENS.USDC.symbol.toLowerCase(),
        })
      ).toEqual(canonicalizeTransferBatchBody({ ...BATCH, token: usdc }));
      expect(
        canonicalizeTransferBatchBody({ ...BATCH, token: WELL_KNOWN_TOKENS.SOL.symbol })
      ).toEqual(canonicalizeTransferBatchBody(BATCH));
    });
  });

  it("keeps a batch that moves anything differently a different request", () => {
    const usdc = required(wellKnownMint("USDC", "devnet"));

    runInClusterScope({ projectId: null, environment: "sandbox" }, () => {
      const original = canonicalizeTransferBatchBody(BATCH);
      for (const changed of [
        { ...BATCH, sourceCustodyWalletId: "cwlt_2" },
        { ...BATCH, token: usdc },
        { ...BATCH, recipients: [{ ...A, amount: "1.5" }, B] },
        { ...BATCH, recipients: [{ ...A, counterpartyAccountId: "cpa_c" }, B] },
        { ...BATCH, recipients: [A] },
        { ...BATCH, externalId: "payroll-11" },
      ]) {
        expect(canonicalizeTransferBatchBody(changed)).not.toEqual(original);
      }
    });
  });
});

describe("previousCanonicalTransferBatchBody", () => {
  // A key or batch row saved before the token was fingerprinted as its mint still matches a retry.
  it("keeps the token as sent, with recipients sorted and amounts canonical", () => {
    const body = {
      ...BATCH,
      token: WELL_KNOWN_TOKENS.SOL.symbol,
      recipients: [
        { ...B, amount: "2.0" },
        { ...A, amount: "01.000" },
      ],
    };

    expect(previousCanonicalTransferBatchBody(body)).toEqual({
      sourceCustodyWalletId: "cwlt_1",
      token: WELL_KNOWN_TOKENS.SOL.symbol,
      recipients: [
        { counterpartyId: "cp_a", counterpartyAccountId: "cpa_a", amount: "1" },
        { counterpartyId: "cp_b", counterpartyAccountId: "cpa_b", amount: "2" },
      ],
    });
  });
});

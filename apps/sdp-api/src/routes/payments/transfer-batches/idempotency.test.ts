import { runInClusterScope } from "@sdp/rpc/scope";
import { SOL_MINT, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@/lib/idempotency";
import {
  canonicalizeTransferBatchBody as canonicalizeOnDevnet,
  previousCanonicalTransferBatchBody as previousOnDevnet,
} from "./idempotency";

/** The canonical form a sandbox project's request takes: its tokens resolve on devnet. */
function canonicalizeTransferBatchBody(body: JsonValue): JsonValue {
  return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
    canonicalizeOnDevnet(body)
  );
}

/** The previous canonical form of a sandbox project's request. */
function previousCanonicalTransferBatchBody(body: JsonValue): JsonValue {
  return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
    previousOnDevnet(body)
  );
}

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

  it("spells recipient amounts canonically and drops empty options", () => {
    const body = {
      sourceCustodyWalletId: "cwlt_1",
      token: SOL_MINT,
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
      token: SOL_MINT,
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

  it("treats an omitted priority fee as none (APE SOLA9-765)", () => {
    const body = {
      sourceCustodyWalletId: "cwlt_1",
      token: SOL_MINT,
      recipients: [{ counterpartyAccountId: "cpa_a", amount: "1" }],
    };

    expect(canonicalizeTransferBatchBody({ ...body, options: { priorityFee: "none" } })).toEqual(
      canonicalizeTransferBatchBody(body)
    );
    expect(canonicalizeTransferBatchBody({ ...body, options: { priorityFee: "high" } })).toEqual({
      ...body,
      options: { priorityFee: "high" },
    });
  });

  it("fingerprints a symbol and its mint as one asset, and native SOL apart from wrapped SOL (APE SOLA9-695)", () => {
    const usdc = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;
    const body = {
      sourceCustodyWalletId: "cwlt_1",
      recipients: [{ counterpartyAccountId: "cpa_a", amount: "1" }],
    };

    expect(canonicalizeTransferBatchBody({ ...body, token: "usdc" })).toEqual(
      canonicalizeTransferBatchBody({ ...body, token: usdc })
    );
    // ADR 0012: "SOL" moves native SOL, the wrapped SOL mint is an SPL token.
    expect(canonicalizeTransferBatchBody({ ...body, token: "SOL" })).not.toEqual(
      canonicalizeTransferBatchBody({ ...body, token: SOL_MINT })
    );
    // Before it both executed as the wrapped SOL mint, so a key saved then still matches either.
    expect(previousCanonicalTransferBatchBody({ ...body, token: "SOL" })).toEqual(
      previousCanonicalTransferBatchBody({ ...body, token: SOL_MINT })
    );
  });

  it("keeps the form before ADR 0012, defaults dropped and the token as the mint it executed as, for keys saved before it", () => {
    const body = {
      sourceCustodyWalletId: "cwlt_1",
      token: "sol",
      recipients: [{ counterpartyAccountId: "cpa_a", amount: "1.0" }],
      options: { maxRecipientsPerTransaction: 20 },
    };
    expect(previousCanonicalTransferBatchBody(body)).toEqual({
      sourceCustodyWalletId: "cwlt_1",
      token: SOL_MINT,
      recipients: [{ counterpartyAccountId: "cpa_a", amount: "1" }],
    });
    expect(previousCanonicalTransferBatchBody(body)).not.toEqual(
      canonicalizeTransferBatchBody(body)
    );
  });

  it("spells the token as the asset it names, and as the mint it executed as in the previous form", () => {
    const body = {
      sourceCustodyWalletId: "cwlt_1",
      recipients: [{ counterpartyAccountId: "cpa_a", amount: "1" }],
    };
    const mint = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;

    expect(canonicalizeTransferBatchBody({ ...body, token: "usdc" })).toEqual({
      ...body,
      token: mint,
    });
    expect(canonicalizeTransferBatchBody({ ...body, token: mint })).toEqual(
      canonicalizeTransferBatchBody({ ...body, token: "USDC" })
    );
    expect(canonicalizeTransferBatchBody({ ...body, token: "sol" })).toEqual({
      ...body,
      token: "SOL",
    });
    expect(previousCanonicalTransferBatchBody({ ...body, token: "usdc" })).toEqual({
      ...body,
      token: mint,
    });
  });

  it("leaves a body without a recipients array untouched for validation to refuse", () => {
    expect(canonicalizeTransferBatchBody({ recipients: "nope" })).toEqual({ recipients: "nope" });
    expect(canonicalizeTransferBatchBody(["unparsed", "{"])).toEqual(["unparsed", "{"]);
  });
});

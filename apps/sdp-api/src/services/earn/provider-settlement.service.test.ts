import type { EarnProviderSettlementCandidate } from "@sdp/earn/types";
import type { ParsedTransaction } from "@sdp/rpc/solana";
import { deriveAssociatedTokenAddress } from "@sdp/solana/address";
import type { EarnMovementDirection } from "@sdp/types/earn";
import { SPL_TOKEN_PROGRAMS, wellKnownMint } from "@sdp/types/well-known-tokens";
import { WISDOMTREE_FUNDS } from "@sdp/types/wisdomtree-programs";
import { describe, expect, it } from "vitest";
import type { EarnMovementRow, EarnPositionRow } from "@/db/repositories/earn-movements.repository";
import { verifyProviderDelivery } from "./provider-settlement.service";

// SAFETY: this pure verifier reads only the recorded identity fields supplied here.
const movement = {
  direction: "withdrawal",
  source_address: "vault",
  destination_address: "owner",
  signature: "source",
  vault_address: "vault",
} as EarnMovementRow;
const position = { token_mint: "usdc", share_mint: "shares" } as EarnPositionRow;
const candidate = {
  sourceSignature: "source",
  owner: "owner",
  destinationSignature: "delivery",
  tokenMint: "usdc",
  programAddress: "bridge",
  requiredAccount: "usdc",
  phase: "processing" as const,
};
function transaction(): ParsedTransaction {
  return {
    slot: 42n,
    executionResultKnown: true,
    err: null,
    accountKeys: ["owner-token-account", "usdc"],
    instructions: [{ programId: "bridge", accounts: [], data: null, parsedType: null, info: null }],
    preTokenBalances: [
      { accountIndex: 0, mint: "usdc", owner: "owner", amount: "100", decimals: 6 },
    ],
    postTokenBalances: [
      { accountIndex: 0, mint: "usdc", owner: "owner", amount: "1000100", decimals: 6 },
    ],
  };
}
describe("provider delivery evidence", () => {
  it("records the exact finalized payout in token units", () => {
    expect(verifyProviderDelivery(movement, position, candidate, transaction())).toMatchObject({
      outcome: "delivered",
      amount: "1",
      observedSlot: "42",
      sourceSignature: "source",
      destinationSignature: "delivery",
    });
  });
  it.each(["sourceSignature", "owner", "tokenMint"] as const)("rejects mismatched %s", (field) => {
    expect(() =>
      verifyProviderDelivery(movement, position, { ...candidate, [field]: "other" }, transaction())
    ).toThrow("identity");
  });
  it("does not turn an unrelated credit into provider fulfillment", () => {
    const tx = transaction();
    tx.instructions = [];
    expect(verifyProviderDelivery(movement, position, candidate, tx)).toBeNull();
  });
  it("requires the intended owner to receive the payout", () => {
    const tx = transaction();
    tx.postTokenBalances = tx.postTokenBalances?.map((balance) => ({ ...balance, owner: "other" }));
    expect(verifyProviderDelivery(movement, position, candidate, tx)).toBeNull();
  });
  it.each(["failed", "missing_metadata"])("does not settle a %s transaction", (mode) => {
    const tx = transaction();
    if (mode === "failed") tx.err = { InstructionError: [0, 1] };
    else tx.executionResultKnown = false;
    expect(verifyProviderDelivery(movement, position, candidate, tx)).toBeNull();
  });
});

describe("WisdomTree provider delivery evidence", () => {
  const owner = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

  async function delivery(direction: EarnMovementDirection) {
    const fund = WISDOMTREE_FUNDS[0];
    const usdc = wellKnownMint("USDC", "mainnet-beta");
    if (fund === undefined || usdc === undefined) throw new Error("Expected mainnet fund and USDC");
    const purchase = direction === "deposit";
    const tokenMint = purchase ? fund.mint : usdc;
    const programAddress = purchase
      ? SPL_TOKEN_PROGRAMS["token-2022"]
      : SPL_TOKEN_PROGRAMS["spl-token"];
    const recipient = await deriveAssociatedTokenAddress(owner, tokenMint, programAddress);
    const amount = purchase ? "2.000000001" : "101.25";
    const atoms = purchase ? "2000000001" : "101250000";
    const decimals = purchase ? fund.decimals : 6;
    const intent = {
      ...movement,
      direction,
      source_address: purchase ? owner : "on-receipt-wallet",
      destination_address: purchase ? "on-receipt-wallet" : owner,
      vault_address: fund.mint,
    };
    const holding = { ...position, token_mint: usdc, share_mint: fund.mint };
    const receipt: EarnProviderSettlementCandidate = {
      sourceSignature: "source",
      owner,
      destinationSignature: "delivery",
      tokenMint,
      expectedAmount: amount,
      programAddress,
      requiredAccount: recipient,
      phase: "processing",
    };
    const tx: ParsedTransaction = {
      slot: 42n,
      executionResultKnown: true,
      err: null,
      // A classic Transfer has no mint account in its instruction.
      accountKeys: purchase ? [recipient, fund.mint] : [recipient],
      instructions: [
        {
          programId: programAddress,
          accounts: [],
          data: null,
          parsedType: purchase ? "mintToChecked" : "transfer",
          info: { destination: recipient, amount: atoms },
        },
      ],
      preTokenBalances: [],
      postTokenBalances: [{ accountIndex: 0, mint: tokenMint, owner, amount: atoms, decimals }],
    };
    return { intent, holding, receipt, tx, amount };
  }

  it.each(["deposit", "withdrawal"] as const)(
    "verifies a %s using its output token program and exact recipient credit",
    async (direction) => {
      const { intent, holding, receipt, tx, amount } = await delivery(direction);
      expect(verifyProviderDelivery(intent, holding, receipt, tx)).toMatchObject({
        ownerAddress: owner,
        providerReference: holding.share_mint,
        tokenMint: receipt.tokenMint,
        amount,
      });
    }
  );

  it.each(["0.5", "2"])("refuses a provider amount of %s against a one-token credit", (amount) => {
    expect(
      verifyProviderDelivery(
        movement,
        position,
        { ...candidate, expectedAmount: amount },
        transaction()
      )
    ).toBeNull();
  });

  it.each(["deposit", "withdrawal"] as const)(
    "does not attribute a batched %s credit to a single provider order",
    async (direction) => {
      const { intent, holding, receipt, tx } = await delivery(direction);
      tx.postTokenBalances = tx.postTokenBalances?.map((balance) => ({
        ...balance,
        amount: (BigInt(balance.amount) * 2n).toString(),
      }));
      expect(verifyProviderDelivery(intent, holding, receipt, tx)).toBeNull();
    }
  );

  it.each(["0", "-1", "1e2", "1.0000001"])(
    "rejects an invalid provider output amount %s",
    (expectedAmount) => {
      expect(() =>
        verifyProviderDelivery(movement, position, { ...candidate, expectedAmount }, transaction())
      ).toThrow();
    }
  );

  it("requires the intended recipient account and token program", async () => {
    const { intent, holding, receipt, tx } = await delivery("withdrawal");
    expect(verifyProviderDelivery(intent, holding, receipt, { ...tx, accountKeys: [] })).toBeNull();
    expect(
      verifyProviderDelivery(intent, holding, receipt, { ...tx, instructions: [] })
    ).toBeNull();
  });
});

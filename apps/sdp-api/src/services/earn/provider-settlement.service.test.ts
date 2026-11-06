import type { ParsedTransaction } from "@sdp/rpc/solana";
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

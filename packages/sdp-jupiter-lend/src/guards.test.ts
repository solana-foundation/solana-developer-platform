import type { EarnVaultTransactionPlan } from "@sdp/earn/types";
import { JUPITER_LEND_EARN_PROGRAM_IDS } from "@sdp/types/jupiter-lend-programs";
import { describe, expect, it } from "vitest";
import { assertJupiterLendPlanPrograms, permittedJupiterLendPrograms } from "./guards";

function plan(programAddress: string): EarnVaultTransactionPlan {
  return {
    cluster: "mainnet-beta",
    instructions: [{ programAddress, accounts: [], data: "" }],
    lookupTables: [],
    assetIdentity: { depositTokenMint: "asset", shareMint: "share" },
  };
}

describe("Jupiter Lend output allowlist", () => {
  it("declares only ATA on devnet because the Earn program is mainnet-only", () => {
    expect([...permittedJupiterLendPrograms("devnet")]).toEqual([
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    ]);
  });

  it("accepts the official mainnet Earn program and rejects an unexpected program", () => {
    expect(
      assertJupiterLendPlanPrograms(plan(JUPITER_LEND_EARN_PROGRAM_IDS["mainnet-beta"] as string))
    ).toBeTruthy();
    expect(() => assertJupiterLendPlanPrograms(plan("11111111111111111111111111111111"))).toThrow(
      /unexpected program/
    );
  });
});

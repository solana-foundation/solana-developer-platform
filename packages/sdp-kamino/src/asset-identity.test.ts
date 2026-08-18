import { describe, expect, it } from "vitest";
import { vaultAssetIdentityFromState } from "./asset-identity";
import { SdpKaminoError } from "./errors";

const DEPOSIT_TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "So11111111111111111111111111111111111111112";

describe("vaultAssetIdentityFromState", () => {
  it("returns the token and share mints observed in live vault state", () => {
    expect(
      vaultAssetIdentityFromState({
        tokenMint: DEPOSIT_TOKEN_MINT,
        sharesMint: SHARE_MINT,
      })
    ).toEqual({
      depositTokenMint: DEPOSIT_TOKEN_MINT,
      shareMint: SHARE_MINT,
    });
  });

  it("fails closed when either state mint is missing or malformed", () => {
    for (const state of [
      { sharesMint: SHARE_MINT },
      { tokenMint: DEPOSIT_TOKEN_MINT },
      { tokenMint: "not-a-mint", sharesMint: SHARE_MINT },
      { tokenMint: DEPOSIT_TOKEN_MINT, sharesMint: "not-a-mint" },
    ]) {
      expect(() => vaultAssetIdentityFromState(state)).toThrow(SdpKaminoError);
    }
  });
});

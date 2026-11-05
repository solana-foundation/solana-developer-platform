import { describe, expect, it } from "vitest";
import { isWalletPurposeOffered } from "./wallet-purposes";

const STABLE = { dvp: false, issuance: false, markets: false };
const EXPERIMENTAL = { dvp: true, issuance: true, markets: true };

describe("isWalletPurposeOffered", () => {
  // Stable runs no Issuance, and its wallet setup offered a mint and a freeze authority.
  it("offers a module's purpose only where that module's area is on", () => {
    expect(isWalletPurposeOffered("transfer", STABLE)).toBe(true);
    expect(isWalletPurposeOffered("fee_payer", STABLE)).toBe(true);
    expect(isWalletPurposeOffered("mint_authority", STABLE)).toBe(false);
    expect(isWalletPurposeOffered("freeze_authority", STABLE)).toBe(false);
    expect(isWalletPurposeOffered("dvp_settlement_authority", STABLE)).toBe(false);

    expect(isWalletPurposeOffered("mint_authority", EXPERIMENTAL)).toBe(true);
    expect(isWalletPurposeOffered("freeze_authority", EXPERIMENTAL)).toBe(true);
    expect(
      isWalletPurposeOffered("dvp_settlement_authority", { ...EXPERIMENTAL, markets: false })
    ).toBe(false);
  });
});

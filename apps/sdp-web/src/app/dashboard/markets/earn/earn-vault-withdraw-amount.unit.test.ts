import { describe, expect, it } from "vitest";
import {
  validateVaultWithdrawalAmount,
  vaultWithdrawalAvailableAmount,
  vaultWithdrawalSharesForAmount,
} from "./earn-vault-withdraw-amount";

const position = {
  shares: "10",
  withdrawableShares: "6",
  tokenValue: "10.5",
};

describe("vault withdrawal dollar sizing", () => {
  it("derives the withdrawable stablecoin value without using floats", () => {
    expect(vaultWithdrawalAvailableAmount(position)).toBe("6.3");
  });

  it("converts a dollar amount to provider share units", () => {
    expect(vaultWithdrawalSharesForAmount("2.5", position)).toBe("2.380952");
  });

  it("uses the exact withdrawable share balance for Max", () => {
    expect(vaultWithdrawalSharesForAmount("6.3", position)).toBe("6");
  });

  it("blocks unavailable, over-limit, and over-precision amounts", () => {
    expect(vaultWithdrawalSharesForAmount("6.300001", position)).toBeUndefined();
    expect(
      vaultWithdrawalSharesForAmount("1", { ...position, tokenValue: undefined })
    ).toBeUndefined();
    expect(validateVaultWithdrawalAmount("1.0000001")).toEqual({ kind: "invalid" });
  });
});

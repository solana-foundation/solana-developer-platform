import { describe, expect, it } from "vitest";
import {
  validateVaultWithdrawalAmount,
  validateVaultWithdrawalShares,
  vaultProviderOrderShares,
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

describe("provider-order share sizing", () => {
  it("preserves an exact nine-decimal share intent", () => {
    expect(vaultProviderOrderShares("6.123456789", { withdrawableShares: "6.123456789" })).toBe(
      "6.123456789"
    );
  });

  it("rejects excess, unavailable, and over-precision share intents", () => {
    expect(
      vaultProviderOrderShares("6.12345679", { withdrawableShares: "6.123456789" })
    ).toBeUndefined();
    expect(vaultProviderOrderShares("1", { withdrawableShares: undefined })).toBeUndefined();
    expect(validateVaultWithdrawalShares("1.0000000001")).toEqual({ kind: "invalid" });
  });
});

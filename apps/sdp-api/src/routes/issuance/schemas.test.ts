import { describe, expect, it } from "vitest";
import {
  burnSchema,
  confirmDeploySchema,
  createTokenSchema,
  deployTokenSchema,
  issuanceTransactionWalletFilterSchema,
  legacyDeployTokenSchema,
  mintSchema,
} from "./schemas";

const ADDRESS = "So11111111111111111111111111111111111111112";

describe("Issuance exact wallet request schemas", () => {
  it("accepts an exact wallet and rejects the legacy selector when creating a token", () => {
    expect(
      createTokenSchema.safeParse({
        name: "Example",
        symbol: "EXM",
        signingCustodyWalletId: "cwlt_example",
      }).success
    ).toBe(true);
    expect(
      createTokenSchema.safeParse({
        name: "Example",
        symbol: "EXM",
        signingWalletId: "privy_example",
      }).success
    ).toBe(false);
  });

  it("uses the exact selector for direct deploy while preserving the legacy prepare contract", () => {
    expect(deployTokenSchema.safeParse({ signingCustodyWalletId: "cwlt_example" }).success).toBe(
      true
    );
    expect(deployTokenSchema.safeParse({ signingWalletId: "privy_example" }).success).toBe(false);

    expect(legacyDeployTokenSchema.safeParse({ signingWalletId: "privy_example" }).success).toBe(
      true
    );
    expect(
      confirmDeploySchema.safeParse({
        signature: "signature",
        mint: ADDRESS,
        signingWalletId: "privy_example",
      }).success
    ).toBe(true);
  });

  it("requires an exact source wallet for burn and keeps authority-based selectors optional", () => {
    const burn = { burn: { source: ADDRESS, amount: "1" } };
    expect(burnSchema.safeParse(burn).success).toBe(false);
    expect(burnSchema.safeParse({ ...burn, signingCustodyWalletId: "cwlt_example" }).success).toBe(
      true
    );
    expect(burnSchema.safeParse({ ...burn, signingWalletId: "privy_example" }).success).toBe(false);

    expect(mintSchema.safeParse({ mint: { destination: ADDRESS, amount: "1" } }).success).toBe(
      true
    );
  });
});

describe("Issuance participant-history wallet filter", () => {
  it("accepts either exact or legacy identity, but never both", () => {
    expect(
      issuanceTransactionWalletFilterSchema.safeParse({ custodyWalletId: "cwlt_example" }).success
    ).toBe(true);
    expect(
      issuanceTransactionWalletFilterSchema.safeParse({ walletId: "privy_example" }).success
    ).toBe(true);
    expect(
      issuanceTransactionWalletFilterSchema.safeParse({
        custodyWalletId: "cwlt_example",
        walletId: "privy_example",
      }).success
    ).toBe(false);
  });
});

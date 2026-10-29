import { describe, expect, it } from "vitest";
import {
  burnSchema,
  confirmDeploySchema,
  createTokenSchema,
  deployTokenSchema,
  issuanceTransactionWalletFilterSchema,
  mintSchema,
  prepareDeployMetadataSchema,
  prepareDeploySchema,
} from "./schemas";

const ADDRESS = "So11111111111111111111111111111111111111112";
const SIGNATURE =
  "2CNiVUkS2FjsZkw2bLksLCxVXsJot5GebHiqorSEzbmFZ4DQ6sJNDg7D438AcKaeQagD2mmdYD7ZTSpsS5YrkwY";

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

  it("uses exact selectors for direct and client-signed deployment", () => {
    expect(deployTokenSchema.safeParse({ signingCustodyWalletId: "cwlt_example" }).success).toBe(
      true
    );
    expect(deployTokenSchema.safeParse({ signingWalletId: "privy_example" }).success).toBe(false);

    expect(prepareDeploySchema.parse({ signingCustodyWalletId: "cwlt_example" })).toMatchObject({
      signingCustodyWalletId: "cwlt_example",
      feePayment: "sponsored",
    });
    expect(prepareDeploySchema.parse({})).toEqual({ feePayment: "sponsored" });
    expect(prepareDeploySchema.safeParse({ signingWalletId: "privy_example" }).success).toBe(false);
  });

  it("rejects retired deployment inputs and preserves unrelated ignored fields", () => {
    for (const schema of [prepareDeploySchema, prepareDeployMetadataSchema, confirmDeploySchema]) {
      for (const signingWalletId of ["privy_example", "", null]) {
        expect(
          schema.safeParse({
            signature: SIGNATURE,
            mint: ADDRESS,
            signingCustodyWalletId: "cwlt_example",
            signingWalletId,
          }).success
        ).toBe(false);
      }
    }
    expect(
      confirmDeploySchema.parse({
        signature: SIGNATURE,
        mint: ADDRESS,
        listAddress: ADDRESS,
        signingCustodyWalletId: "cwlt_ignored",
        unrelated: "ignored",
      })
    ).toEqual({ signature: SIGNATURE, mint: ADDRESS, listAddress: ADDRESS });
    expect(
      prepareDeployMetadataSchema.parse({
        signingCustodyWalletId: "cwlt_ignored",
        listAddress: ADDRESS,
        feePayment: "wallet",
      })
    ).toEqual({ feePayment: "wallet" });
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
  it("accepts exact identity or no filter and rejects retired wallet selectors", () => {
    expect(
      issuanceTransactionWalletFilterSchema.safeParse({ custodyWalletId: "cwlt_example" }).success
    ).toBe(true);
    expect(issuanceTransactionWalletFilterSchema.safeParse({}).success).toBe(true);
    for (const walletId of ["privy_example", "", " "]) {
      expect(issuanceTransactionWalletFilterSchema.safeParse({ walletId }).success).toBe(false);
    }
    expect(
      issuanceTransactionWalletFilterSchema.safeParse({
        custodyWalletId: "cwlt_example",
        walletId: "privy_example",
      }).success
    ).toBe(false);
  });
});

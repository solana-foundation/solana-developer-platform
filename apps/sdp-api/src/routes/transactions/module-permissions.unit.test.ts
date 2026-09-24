import { describe, expect, it } from "vitest";
import { permittedUnifiedTransactionModules } from "./module-permissions";

describe("unified transaction module permissions", () => {
  it("limits payments-only keys to payment-scoped modules", () => {
    expect(permittedUnifiedTransactionModules(["payments:read"])).toEqual([
      "payments",
      "private_channels",
      "rings",
    ]);
  });

  it("limits earn-only keys to Earn", () => {
    expect(permittedUnifiedTransactionModules(["earn:read"])).toEqual(["earn"]);
  });

  it("requires both wallet and payment read access for DvP", () => {
    expect(permittedUnifiedTransactionModules(["wallets:read"])).toEqual([]);
    expect(permittedUnifiedTransactionModules(["wallets:read", "payments:read"])).toEqual([
      "payments",
      "dvp",
      "private_channels",
      "rings",
    ]);
  });

  it("allows wildcard identities to see every module", () => {
    expect(permittedUnifiedTransactionModules("*")).toEqual([
      "payments",
      "earn",
      "dvp",
      "private_channels",
      "issuance",
      "rings",
    ]);
  });
});

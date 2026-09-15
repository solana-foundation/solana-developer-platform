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

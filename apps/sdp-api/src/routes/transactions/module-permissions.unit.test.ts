import { type Action, API_KEY_GRANTABLE_ACTIONS, apiKeyMayPerform } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { permittedUnifiedTransactionModules } from "./module-permissions";

function forGrants(grants: readonly Action[]) {
  return permittedUnifiedTransactionModules((action) => apiKeyMayPerform(grants, action));
}

describe("unified transaction module actions", () => {
  it("limits a transactions-only key to payments rows", () => {
    expect(forGrants(["transactions.read"])).toEqual(["payments"]);
  });

  it("adds a module's rows with that module's read, implied by its execute", () => {
    expect(forGrants(["transactions.read", "earn.execute"])).toEqual(["payments", "earn"]);
  });

  it("shows every module to a key holding everything", () => {
    expect(forGrants(API_KEY_GRANTABLE_ACTIONS)).toEqual([
      "payments",
      "earn",
      "dvp",
      "private_channels",
      "issuance",
      "rings",
    ]);
  });
});

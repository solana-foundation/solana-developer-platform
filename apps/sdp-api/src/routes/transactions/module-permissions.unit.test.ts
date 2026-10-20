import { type Action, API_KEY_GRANTABLE_ACTIONS, apiKeyMayPerform } from "@sdp/types/actions";
import { describe, expect, it } from "vitest";
import {
  permittedPaymentTransactionKinds,
  permittedUnifiedTransactionModules,
} from "./module-permissions";

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

describe("Payments row kinds by the read of their module", () => {
  function kindsFor(grants: readonly Action[]) {
    return permittedPaymentTransactionKinds((action) => apiKeyMayPerform(grants, action));
  }

  it("shows a transactions-only key no Payments kind", () => {
    expect(kindsFor(["transactions.read"])).toEqual([]);
  });

  it("maps each kind to its module's read", () => {
    expect(kindsFor(["transfers.read"])).toEqual(["pay", "confidential_pay", "deposit"]);
    expect(kindsFor(["transfer_batches.execute"])).toEqual(["batch_pay"]);
    expect(kindsFor(["recurring.manage"])).toEqual(["recurring_pay"]);
    expect(kindsFor(["payment_requests.read"])).toEqual(["request_deposit"]);
    expect(kindsFor(["onramp.read", "offramp.execute"])).toEqual(["onramp", "offramp"]);
  });
});

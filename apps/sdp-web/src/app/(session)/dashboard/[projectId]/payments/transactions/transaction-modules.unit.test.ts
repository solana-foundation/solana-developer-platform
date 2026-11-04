import { UNIFIED_TRANSACTION_MODULES } from "@sdp/types/unified-transactions";
import { describe, expect, it } from "vitest";
import {
  enabledPaymentTransactionKinds,
  enabledTransactionModules,
  type TransactionModuleFlags,
} from "./transaction-modules";

const ALL_ON: TransactionModuleFlags = {
  dvp: true,
  earn: true,
  heliusRings: true,
  issuance: true,
  markets: true,
  payments: true,
  privateChannels: true,
};

describe("enabledTransactionModules", () => {
  it("lists every module when every area is on", () => {
    expect(enabledTransactionModules(ALL_ON)).toEqual([...UNIFIED_TRANSACTION_MODULES]);
  });

  it("lists only Payments when the release channel caps the rest off (stable today)", () => {
    expect(
      enabledTransactionModules({
        ...ALL_ON,
        dvp: false,
        earn: false,
        heliusRings: false,
        issuance: false,
        markets: false,
        privateChannels: false,
      })
    ).toEqual(["payments"]);
  });

  it("hides Earn and DvP without Markets, as the sidebar does", () => {
    expect(enabledTransactionModules({ ...ALL_ON, markets: false })).toEqual([
      "payments",
      "private_channels",
      "issuance",
      "rings",
    ]);
  });
});

describe("enabledPaymentTransactionKinds", () => {
  // Stable's Type filter offered Onramp, Offramp and Confidential pay, none of which it records.
  it("offers ramps only where the channel runs Ramps, and confidential pay nowhere", () => {
    expect(enabledPaymentTransactionKinds({ ramps: false })).toEqual([
      "pay",
      "batch_pay",
      "recurring_pay",
      "deposit",
      "request_deposit",
    ]);
    expect(enabledPaymentTransactionKinds({ ramps: true })).toEqual([
      "pay",
      "batch_pay",
      "recurring_pay",
      "deposit",
      "request_deposit",
      "onramp",
      "offramp",
    ]);
  });
});

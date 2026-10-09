import { UNIFIED_TRANSACTION_MODULES } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { enabledTransactionModules, type TransactionModuleFlags } from "./transaction-modules";

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

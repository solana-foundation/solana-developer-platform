import { describe, expect, it } from "vitest";
import { labelFor } from "./event-names";

const NAMES = {
  Sender1111111111111111111111111111111111: "Treasury Wallet",
  wallet_treasury: "Treasury Wallet",
  pch_treasury: "Treasury",
  usr_ada: "Ada Lovelace",
};

describe("labelFor", () => {
  it("returns the mapped name when present", () => {
    expect(labelFor(NAMES, "Sender1111111111111111111111111111111111")).toBe("Treasury Wallet");
    expect(labelFor(NAMES, "wallet_treasury")).toBe("Treasury Wallet");
    expect(labelFor(NAMES, "pch_treasury")).toBe("Treasury");
    expect(labelFor(NAMES, "usr_ada")).toBe("Ada Lovelace");
  });

  it("falls back to a shortened value for unknown keys", () => {
    expect(labelFor(NAMES, "UnknownPubkey11111111111111111111111111")).toBe("Unknow…1111");
  });

  it("returns undefined for missing values", () => {
    expect(labelFor(NAMES, undefined)).toBeUndefined();
  });
});

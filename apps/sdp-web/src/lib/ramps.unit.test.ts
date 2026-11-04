import { describe, expect, it } from "vitest";
import { offersSandboxSettlement } from "./ramps";

describe("offersSandboxSettlement", () => {
  it("offers a sandbox Hercle deposit the flags enable", () => {
    expect(offersSandboxSettlement("hercle", "sandbox", ["moonpay", "hercle"])).toBe(true);
  });

  it("never offers a production deposit, whose money is real", () => {
    expect(offersSandboxSettlement("hercle", "production", ["hercle"])).toBe(false);
  });

  it.each(["moonpay", "stripe"] as const)(
    "offers nothing for %s, which the API does not settle on request",
    (provider) => {
      expect(offersSandboxSettlement(provider, "sandbox", [provider])).toBe(false);
    }
  );

  it("offers nothing for a provider the release channel or its flag leaves out", () => {
    expect(offersSandboxSettlement("hercle", "sandbox", ["moonpay", "stripe"])).toBe(false);
  });
});

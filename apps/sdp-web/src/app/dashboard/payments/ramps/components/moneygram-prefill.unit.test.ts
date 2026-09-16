import { describe, expect, it } from "vitest";
import { buildOfframpTransactionPrefill, buildOnrampTransactionPrefill } from "./moneygram-prefill";

// Personal data MoneyGram collects inside its own widget. The dashboard must
// never hand any of it over through the transaction prefill; this list is the
// tripwire if a future edit tries.
const PII_KEYS = [
  "address",
  "dateOfBirth",
  "email",
  "firstName",
  "lastName",
  "name",
  "phone",
  "phoneNumber",
];

function keysOf(prefill: ReturnType<typeof buildOnrampTransactionPrefill>): string[] {
  return Object.keys(prefill).sort();
}

describe("MoneyGram transaction prefill", () => {
  it("on-ramp carries only direction, amount and asset", () => {
    const prefill = buildOnrampTransactionPrefill("25", "USDC");
    expect(keysOf(prefill)).toEqual(["amount", "asset", "type"]);
    expect(prefill).toEqual({ type: "on-ramp", amount: 25, asset: "USDC" });
  });

  it("off-ramp in USD adds the destination country and currency, nothing else", () => {
    const prefill = buildOfframpTransactionPrefill("USD", "USDC", "25");
    expect(keysOf(prefill)).toEqual([
      "amount",
      "asset",
      "destinationCountry",
      "destinationCurrency",
      "type",
    ]);
    expect(prefill).toEqual({
      type: "off-ramp",
      destinationCountry: "USA",
      destinationCurrency: "USD",
      amount: 25,
      asset: "USDC",
    });
  });

  it("off-ramp in MXN maps to Mexico", () => {
    const prefill = buildOfframpTransactionPrefill("MXN", "USDC", "25");
    expect(prefill.destinationCountry).toBe("MEX");
  });

  it("off-ramp in a currency without a country mapping omits the country key", () => {
    const prefill = buildOfframpTransactionPrefill("EUR", "USDC", "25");
    expect(keysOf(prefill)).toEqual(["amount", "asset", "destinationCurrency", "type"]);
  });

  it("never includes personal data in either direction", () => {
    const prefills = [
      buildOnrampTransactionPrefill("25", "USDC"),
      buildOfframpTransactionPrefill("USD", "USDC", "25"),
      buildOfframpTransactionPrefill("MXN", "USDC", "25"),
    ];
    for (const prefill of prefills) {
      for (const key of PII_KEYS) {
        expect(prefill).not.toHaveProperty(key);
      }
    }
  });
});

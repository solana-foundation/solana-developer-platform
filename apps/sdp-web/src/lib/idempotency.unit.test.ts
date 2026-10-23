import { canonicalJson } from "@sdp/types/idempotency";
import { describe, expect, it } from "vitest";
import { canonicalDecimalAmount, canonicalizeAmounts } from "./idempotency";

describe("canonicalDecimalAmount", () => {
  it("spells one amount one way, as the API fingerprints it", () => {
    expect(canonicalDecimalAmount("1.0")).toBe("1");
    expect(canonicalDecimalAmount("25.00")).toBe(canonicalDecimalAmount("25.0"));
    expect(canonicalDecimalAmount("01.50")).toBe("1.5");
    expect(canonicalDecimalAmount("0.010")).toBe("0.01");
  });

  it("keeps genuinely different amounts apart", () => {
    expect(canonicalDecimalAmount("1.01")).not.toBe(canonicalDecimalAmount("1"));
    expect(canonicalDecimalAmount("10")).not.toBe(canonicalDecimalAmount("1"));
    expect(canonicalDecimalAmount("0.1")).not.toBe(canonicalDecimalAmount("1"));
  });

  it("leaves what is not a decimal string as typed, for the API to refuse", () => {
    expect(canonicalDecimalAmount("")).toBe("");
    expect(canonicalDecimalAmount("-1.0")).toBe("-1.0");
    expect(canonicalDecimalAmount("1e3")).toBe("1e3");
  });
});

describe("canonicalJson", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: { d: [2, 1], c: null }, a: "x" })).toBe(
      '{"a":"x","b":{"c":null,"d":[2,1]}}'
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("orders keys by UTF-16 code unit, not locale", () => {
    expect(canonicalJson({ b: 1, B: 2, "10": 0, "9": 0 })).toBe('{"10":0,"9":0,"B":2,"b":1}');
  });
});

describe("canonicalizeAmounts", () => {
  it("spells every amount canonically at any depth and leaves the rest as sent", () => {
    expect(
      canonicalizeAmounts({
        amount: "100.00",
        token: "USDC",
        memo: "1.0",
        recipients: [{ counterpartyAccountId: "cpa_1", amount: "01.50" }, { amount: "2" }],
      })
    ).toEqual({
      amount: "100",
      token: "USDC",
      memo: "1.0",
      recipients: [{ counterpartyAccountId: "cpa_1", amount: "1.5" }, { amount: "2" }],
    });
  });

  it("keys a re-spelled payment as the same request and a different amount as a new one", () => {
    const key = (amount: string) => canonicalJson(canonicalizeAmounts({ amount }));
    expect(key("100")).toBe(key("100.00"));
    expect(key("100.01")).not.toBe(key("100"));
  });

  it("leaves an amount that is not a decimal string as typed", () => {
    expect(canonicalizeAmounts({ amount: "" })).toEqual({ amount: "" });
    expect(canonicalizeAmounts({ amount: 5 })).toEqual({ amount: 5 });
  });
});

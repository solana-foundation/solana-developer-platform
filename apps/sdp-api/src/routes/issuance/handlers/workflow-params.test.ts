import { describe, expect, it } from "vitest";
import { isSecretParamKey, redactActionParams, validateActionParams } from "./workflow-params";

const WALLET = "So11111111111111111111111111111111111111112";

describe("validateActionParams", () => {
  it("accepts a well-formed mint rule", () => {
    expect(validateActionParams("mint", { amount: "100.5", wallet: WALLET })).toEqual({ ok: true });
  });

  it("coerces a numeric amount from JSON", () => {
    expect(validateActionParams("mint", { amount: 100 })).toEqual({ ok: true });
  });

  it.each(["0", "-5", "abc", "1e9", ""])("rejects the amount %s", (amount) => {
    const result = validateActionParams("mint", { amount });
    expect(result.ok).toBe(false);
  });

  it("requires an amount for mint", () => {
    const result = validateActionParams("mint", { wallet: WALLET });
    expect(result.ok).toBe(false);
  });

  it("rejects a wallet that is not a valid address", () => {
    const result = validateActionParams("mint", { amount: "1", wallet: "not-an-address" });
    expect(result.ok).toBe(false);
  });

  it("requires a destination for seize", () => {
    expect(validateActionParams("seize", { amount: "1", source: WALLET }).ok).toBe(false);
    expect(
      validateActionParams("seize", { amount: "1", source: WALLET, destination: WALLET }).ok
    ).toBe(true);
  });

  // An unknown key is nearly always a typo, and storing it produces a rule that only
  // fails when it fires.
  it("rejects unknown params rather than storing them", () => {
    const result = validateActionParams("mint", { amount: "1", walletAddress: WALLET });
    expect(result.ok).toBe(false);
  });

  describe("send_webhook url", () => {
    it("accepts a public https endpoint", () => {
      expect(validateActionParams("send_webhook", { url: "https://hooks.example.com/x" })).toEqual({
        ok: true,
      });
    });

    it.each([
      "http://hooks.example.com/x",
      "https://127.0.0.1/x",
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.1/x",
      "https://192.168.1.1/x",
      "https://metadata.google.internal/x",
      "https://localhost/x",
      "not-a-url",
    ])("refuses %s at save time", (url) => {
      expect(validateActionParams("send_webhook", { url }).ok).toBe(false);
    });

    it("requires a secret long enough to be worth signing with", () => {
      expect(
        validateActionParams("send_webhook", { url: "https://a.example.com/x", secret: "short" }).ok
      ).toBe(false);
    });
  });

  it("constrains the notify audience and email", () => {
    expect(validateActionParams("notify", { audience: "everyone" }).ok).toBe(false);
    expect(validateActionParams("notify", { audience: "admins" }).ok).toBe(true);
    expect(validateActionParams("notify", { email: "not-an-email" }).ok).toBe(false);
    expect(validateActionParams("notify", { email: "ops@example.com" }).ok).toBe(true);
  });
});

describe("secret redaction", () => {
  it.each(["secret", "apiKey", "api_key", "authToken", "password"])(
    "treats %s as a credential",
    (key) => {
      expect(isSecretParamKey(key)).toBe(true);
    }
  );

  it.each(["url", "amount", "wallet", "audience"])("leaves %s alone", (key) => {
    expect(isSecretParamKey(key)).toBe(false);
  });

  it("strips credentials from a read response and reports that one exists", () => {
    const { params, hasSecret } = redactActionParams({
      url: "https://a.example.com/x",
      secret: "super-secret-value",
    });
    expect(params).toEqual({ url: "https://a.example.com/x" });
    expect(hasSecret).toBe(true);
    expect(JSON.stringify(params)).not.toContain("super-secret-value");
  });

  it("reports no secret when there isn't one", () => {
    expect(redactActionParams({ amount: "1" })).toEqual({
      params: { amount: "1" },
      hasSecret: false,
    });
  });
});

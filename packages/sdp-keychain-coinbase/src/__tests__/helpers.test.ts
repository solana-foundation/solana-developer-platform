import { describe, expect, it } from "vitest";
import { createCoinbaseCdpBearerJwt, createCoinbaseCdpWalletJwt } from "../jwt.js";
import { getNestedProp, requiresWalletAuth, resolveRequestUrl, sortJsonKeys } from "../utils.js";

describe("helper utilities", () => {
  it("sorts nested object keys deterministically", () => {
    const sorted = sortJsonKeys({
      z: 1,
      a: { b: 2, a: 1 },
      c: [{ z: 2, a: 1 }],
    });

    expect(Object.keys(sorted as Record<string, unknown>)).toEqual(["a", "c", "z"]);
    expect(Object.keys((sorted as { a: Record<string, unknown> }).a)).toEqual(["a", "b"]);
  });

  it("preserves base path when resolving request URLs", () => {
    const { requestPath, url } = resolveRequestUrl(
      "https://api.cdp.coinbase.com/platform",
      "/v2/solana/accounts/abc"
    );

    expect(url.toString()).toBe("https://api.cdp.coinbase.com/platform/v2/solana/accounts/abc");
    expect(requestPath).toBe("/platform/v2/solana/accounts/abc");
  });

  it("computes wallet auth requirement", () => {
    expect(requiresWalletAuth("POST", "/platform/v2/solana/accounts/abc/sign/message")).toBe(true);
    expect(requiresWalletAuth("GET", "/platform/v2/solana/accounts/abc")).toBe(false);
  });

  it("reads nested values safely", () => {
    const value = getNestedProp<{ signature: string }>(
      { data: { signature: "sig" } },
      "data.signature"
    );
    expect(value).toBe("sig");
  });
});

describe("jwt helpers", () => {
  it("rejects invalid bearer key format", async () => {
    await expect(
      createCoinbaseCdpBearerJwt({
        apiKeyId: "key-id",
        apiKeySecret: "AQID",
        requestHost: "api.cdp.coinbase.com",
        requestMethod: "POST",
        requestPath: "/platform/v2/solana/accounts/abc/sign/message",
      })
    ).rejects.toThrow(/invalid format/i);
  });

  it("rejects invalid wallet secret", async () => {
    await expect(
      createCoinbaseCdpWalletJwt({
        requestData: { message: "dGVzdA==" },
        requestHost: "api.cdp.coinbase.com",
        requestMethod: "POST",
        requestPath: "/platform/v2/solana/accounts/abc/sign/message",
        walletSecret: "AQID",
      })
    ).rejects.toThrow();
  });
});

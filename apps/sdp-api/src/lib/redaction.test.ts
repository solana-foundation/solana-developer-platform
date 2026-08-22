import {
  redactCredentialSecrets,
  redactCredentialString,
  summarizeUpstreamErrorBody,
} from "@sdp/custody";
import { describe, expect, it } from "vitest";

describe("credential redaction", () => {
  it("redacts credential-shaped object fields without hiding safe ids", () => {
    const redacted = redactCredentialSecrets({
      tokenId: "tok_public",
      appSecret: "privy-secret",
      apiSecret: "api-secret",
      privateKey: "private-key",
      authorization: "Bearer raw-token",
      nested: {
        fireblocksApiSecretPem: "pem-secret",
        coinbaseCdpWalletSecret: "wallet-secret",
        turnkeyApiPrivateKey: "turnkey-private-key",
      },
    });

    expect(redacted).toEqual({
      tokenId: "tok_public",
      appSecret: "[REDACTED]",
      apiSecret: "[REDACTED]",
      privateKey: "[REDACTED]",
      authorization: "[REDACTED]",
      nested: {
        fireblocksApiSecretPem: "[REDACTED]",
        coinbaseCdpWalletSecret: "[REDACTED]",
        turnkeyApiPrivateKey: "[REDACTED]",
      },
    });
  });

  it("redacts credential-shaped strings from provider errors", () => {
    const message = redactCredentialString(
      'Privy API error: 401 - {"appSecret":"privy-secret","apiKey":"api-key","password":"pw"} authorization=Bearer raw-token apiSecret: raw-api-secret api_key=raw-key'
    );

    expect(message).toContain('"appSecret":"[REDACTED]"');
    expect(message).toContain('"apiKey":"[REDACTED]"');
    expect(message).toContain('"password":"[REDACTED]"');
    expect(message).toContain("authorization=[REDACTED]");
    expect(message).toContain("apiSecret: [REDACTED]");
    expect(message).toContain("api_key=[REDACTED]");
    expect(message).not.toContain("privy-secret");
    expect(message).not.toContain("api-key");
    expect(message).not.toContain("raw-token");
    expect(message).not.toContain("raw-api-secret");
    expect(message).not.toContain("raw-key");
  });

  it("keeps plain Basic/Bearer prose intact", () => {
    expect(redactCredentialString("Basic validation failed")).toBe("Basic validation failed");
    expect(redactCredentialString("Bearer access denied")).toBe("Bearer access denied");
  });

  it("redacts PEM blocks", () => {
    const redacted = redactCredentialString(
      "bad pem -----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----"
    );

    expect(redacted).toBe("bad pem [REDACTED]");
  });
});

describe("upstream error summaries", () => {
  it("keeps identifier-shaped codes from known error fields", () => {
    expect(summarizeUpstreamErrorBody('{"errorCode":"WALLET_NOT_FOUND"}')).toBe("WALLET_NOT_FOUND");
    expect(summarizeUpstreamErrorBody('{"errorType":"already_exists"}')).toBe("already_exists");
    expect(summarizeUpstreamErrorBody('{"error":{"code":"InvalidCredential"}}')).toBe(
      "InvalidCredential"
    );
  });

  it("prefers the descriptive status over a code that repeats the HTTP status", () => {
    expect(
      summarizeUpstreamErrorBody('{"error":{"code":400,"status":"INVALID_ARGUMENT"}}', 400)
    ).toBe("INVALID_ARGUMENT");
  });

  it("drops prose, oversized values, and unparsable bodies", () => {
    expect(summarizeUpstreamErrorBody('{"error":{"code":"Bearer sk_live_abc is invalid"}}')).toBe(
      "unavailable"
    );
    expect(summarizeUpstreamErrorBody(`{"code":"${"a".repeat(65)}"}`)).toBe("unavailable");
    expect(summarizeUpstreamErrorBody('{"message":"authorization: Bearer sk_live_abc"}')).toBe(
      "unavailable"
    );
    expect(summarizeUpstreamErrorBody("<html>Bearer sk_live_abc</html>")).toBe("unavailable");
    expect(summarizeUpstreamErrorBody('["Bearer sk_live_abc"]')).toBe("unavailable");
  });
});

import { describe, expect, it } from "vitest";
import { redactCredentialSecrets, redactCredentialString } from "./redaction";

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

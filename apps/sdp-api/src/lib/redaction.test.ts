import { redactCredentialSecrets, redactCredentialString } from "@sdp/redaction";
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

  it("redacts a header-style credential key in its quoted form", () => {
    // `isCredentialKey` matches object keys by suffix, so `x-api-key` is covered
    // when it arrives as a key. Once the same headers have been stringified —
    // a serialized `request.headers`, a provider error quoting the request it
    // rejected — only this pass sees them, and it has to match the same way.
    const message = redactCredentialString(
      'upstream rejected {"x-api-key":"sk_live_supersecret","X-Signing-Secret":"whsec_1"}'
    );

    expect(message).toContain('"x-api-key":"[REDACTED]"');
    expect(message).toContain('"X-Signing-Secret":"[REDACTED]"');
    expect(message).not.toContain("sk_live_supersecret");
    expect(message).not.toContain("whsec_1");
  });

  it("keeps a safe key whose name merely ends in an allowed word", () => {
    // The prefix group must not swallow keys that are not credentials, and must
    // not run past the `:` into a neighbouring field's value.
    const message = redactCredentialString(
      '{"tokenName":"USD Coin","providerName":"bvnk","walletId":"wal_01HZY"}'
    );

    expect(message).toContain('"tokenName":"USD Coin"');
    expect(message).toContain('"providerName":"bvnk"');
    expect(message).toContain('"walletId":"wal_01HZY"');
  });

  it("keeps plain Basic/Bearer prose intact", () => {
    expect(redactCredentialString("Basic validation failed")).toBe("Basic validation failed");
    expect(redactCredentialString("Bearer access denied")).toBe("Bearer access denied");
  });

  it("leaves counterparty PII alone, because this pass feeds client-facing errors", () => {
    // A 4xx body goes back to the tenant that submitted the data, so a
    // validation error has to keep naming the field that failed. PII scrubbing
    // is the telemetry pass (`scrubTelemetry` / `scrubAuditMetadata`), not this
    // one — see docs/security/pii-scrubbing-policy.md.
    const redacted = redactCredentialSecrets({
      email: "jane.doe@example.com",
      identity: { firstName: "Jane" },
      appSecret: "privy-secret",
    });

    expect(redacted).toEqual({
      email: "jane.doe@example.com",
      identity: { firstName: "Jane" },
      appSecret: "[REDACTED]",
    });
  });

  it("redacts PEM blocks", () => {
    const redacted = redactCredentialString(
      "bad pem -----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----"
    );

    expect(redacted).toBe("bad pem [REDACTED]");
  });
});

import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature, WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS } from "./webhook-signature";

const SECRET = "whsec_test_secret";
const BODY = '{"type":"transfer.settled","id":"abc"}';

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe("verifyWebhookSignature", () => {
  describe("hmac-sha256 (base64 encoded signed body timestamp)", () => {
    it("accepts a fresh, valid signature", async () => {
      const signature = createHmac("sha256", SECRET).update(BODY).digest("base64");
      await expect(
        verifyWebhookSignature({
          provider: "moonpay",
          signature,
          signedPayload: BODY,
          algorithm: { type: "hmac-sha256", secret: SECRET, encoding: "base64" },
          timestampSeconds: nowSeconds(),
        })
      ).resolves.toBeUndefined();
    });

    it("rejects a tampered body", async () => {
      const signature = createHmac("sha256", SECRET).update(BODY).digest("base64");
      await expect(
        verifyWebhookSignature({
          provider: "moonpay",
          signature,
          signedPayload: `${BODY} tampered`,
          algorithm: { type: "hmac-sha256", secret: SECRET, encoding: "base64" },
          timestampSeconds: nowSeconds(),
        })
      ).rejects.toThrow(/Invalid moonpay webhook signature/);
    });

    it("rejects a wrong secret", async () => {
      const signature = createHmac("sha256", "other_secret").update(BODY).digest("base64");
      await expect(
        verifyWebhookSignature({
          provider: "moonpay",
          signature,
          signedPayload: BODY,
          algorithm: { type: "hmac-sha256", secret: SECRET, encoding: "base64" },
          timestampSeconds: nowSeconds(),
        })
      ).rejects.toThrow(/Invalid moonpay webhook signature/);
    });
  });

  describe("hmac-sha256 (MoonPay shape: hex, signed timestamp)", () => {
    const sign = (ts: number) => createHmac("sha256", SECRET).update(`${ts}.${BODY}`).digest("hex");

    it("accepts a fresh, valid signature", async () => {
      const ts = nowSeconds();
      await expect(
        verifyWebhookSignature({
          provider: "moonpay",
          signature: sign(ts),
          signedPayload: `${ts}.${BODY}`,
          algorithm: { type: "hmac-sha256", secret: SECRET, encoding: "hex" },
          timestampSeconds: ts,
        })
      ).resolves.toBeUndefined();
    });

    it("rejects a replayed (stale) event even with a valid signature", async () => {
      const ts = nowSeconds() - (WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 60);
      await expect(
        verifyWebhookSignature({
          provider: "moonpay",
          signature: sign(ts),
          signedPayload: `${ts}.${BODY}`,
          algorithm: { type: "hmac-sha256", secret: SECRET, encoding: "hex" },
          timestampSeconds: ts,
        })
      ).rejects.toThrow(/outside the .* tolerance window/);
    });

    it("rejects a missing or unparseable timestamp", async () => {
      const ts = nowSeconds();
      await expect(
        verifyWebhookSignature({
          provider: "moonpay",
          signature: sign(ts),
          signedPayload: `${ts}.${BODY}`,
          algorithm: { type: "hmac-sha256", secret: SECRET, encoding: "hex" },
          timestampSeconds: Number.NaN,
        })
      ).rejects.toThrow(/Invalid moonpay webhook timestamp/);
    });

    it("rejects malformed hex", async () => {
      const ts = nowSeconds();
      await expect(
        verifyWebhookSignature({
          provider: "moonpay",
          signature: "not-hex!!",
          signedPayload: `${ts}.${BODY}`,
          algorithm: { type: "hmac-sha256", secret: SECRET, encoding: "hex" },
          timestampSeconds: ts,
        })
      ).rejects.toThrow(/Invalid moonpay webhook signature/);
    });
  });

  describe("ecdsa-p256-sha256 (Hercle shape: public key, base64 DER, signed timestamp)", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const otherPublicKeyPem = other.publicKey.export({ format: "pem", type: "spki" }).toString();
    const sign = (payload: string) =>
      createSign("SHA256").update(payload).sign(privateKey, "base64");
    const verify = (input: {
      signature: string;
      signedPayload: string;
      timestampSeconds: number;
      publicKeyPem?: string;
    }) =>
      verifyWebhookSignature({
        provider: "hercle",
        signature: input.signature,
        signedPayload: input.signedPayload,
        algorithm: {
          type: "ecdsa-p256-sha256",
          publicKeyPem: input.publicKeyPem ?? publicKeyPem,
          encoding: "base64",
        },
        timestampSeconds: input.timestampSeconds,
      });

    it("accepts a fresh, valid signature", async () => {
      const ts = nowSeconds();
      await expect(
        verify({
          signature: sign(`${ts}.${BODY}`),
          signedPayload: `${ts}.${BODY}`,
          timestampSeconds: ts,
        })
      ).resolves.toBeUndefined();
    });

    it("rejects a tampered body", async () => {
      const ts = nowSeconds();
      await expect(
        verify({
          signature: sign(`${ts}.${BODY}`),
          signedPayload: `${ts}.${BODY} tampered`,
          timestampSeconds: ts,
        })
      ).rejects.toThrow(/Invalid hercle webhook signature/);
    });

    it("rejects a signature made with another key", async () => {
      const ts = nowSeconds();
      await expect(
        verify({
          signature: sign(`${ts}.${BODY}`),
          signedPayload: `${ts}.${BODY}`,
          timestampSeconds: ts,
          publicKeyPem: otherPublicKeyPem,
        })
      ).rejects.toThrow(/Invalid hercle webhook signature/);
    });

    it("rejects a stale event even with a valid signature", async () => {
      const ts = nowSeconds() - (WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 60);
      await expect(
        verify({
          signature: sign(`${ts}.${BODY}`),
          signedPayload: `${ts}.${BODY}`,
          timestampSeconds: ts,
        })
      ).rejects.toThrow(/outside the .* tolerance window/);
    });

    it("rejects a signature that is not DER", async () => {
      const ts = nowSeconds();
      await expect(
        verify({
          signature: Buffer.from("not a der signature").toString("base64"),
          signedPayload: `${ts}.${BODY}`,
          timestampSeconds: ts,
        })
      ).rejects.toThrow(/Invalid hercle webhook signature/);
    });

    it("accepts a key stored with literal \\n escapes", async () => {
      const ts = nowSeconds();
      await expect(
        verify({
          signature: sign(`${ts}.${BODY}`),
          signedPayload: `${ts}.${BODY}`,
          timestampSeconds: ts,
          publicKeyPem: publicKeyPem.replace(/\n/g, "\\n"),
        })
      ).resolves.toBeUndefined();
    });
  });
});

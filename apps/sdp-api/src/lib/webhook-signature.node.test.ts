import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature, WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS } from "./webhook-signature";

const SECRET = "whsec_test_secret";
const BODY = '{"type":"transfer.settled","id":"abc"}';

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe("verifyWebhookSignature", () => {
  describe("hmac-sha256 (BVNK shape: base64, signed body timestamp)", () => {
    it("accepts a fresh, valid signature", async () => {
      const signature = createHmac("sha256", SECRET).update(BODY).digest("base64");
      await expect(
        verifyWebhookSignature({
          provider: "bvnk",
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
          provider: "bvnk",
          signature,
          signedPayload: `${BODY} tampered`,
          algorithm: { type: "hmac-sha256", secret: SECRET, encoding: "base64" },
          timestampSeconds: nowSeconds(),
        })
      ).rejects.toThrow(/Invalid bvnk webhook signature/);
    });

    it("rejects a wrong secret", async () => {
      const signature = createHmac("sha256", "other_secret").update(BODY).digest("base64");
      await expect(
        verifyWebhookSignature({
          provider: "bvnk",
          signature,
          signedPayload: BODY,
          algorithm: { type: "hmac-sha256", secret: SECRET, encoding: "base64" },
          timestampSeconds: nowSeconds(),
        })
      ).rejects.toThrow(/Invalid bvnk webhook signature/);
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
});

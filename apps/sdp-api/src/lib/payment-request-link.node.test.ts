import { describe, expect, it } from "vitest";
import {
  type PaymentRequestLinkPayload,
  signPaymentRequestLink,
  verifyPaymentRequestLink,
} from "./payment-request-link";

const SECRET = "prsec_test_secret";

const payload = (overrides?: Partial<PaymentRequestLinkPayload>): PaymentRequestLinkPayload => ({
  requestId: "preq_123",
  recipient: "Hsd1nrFjY1Q5C5x2pZ7y6FfQ9aMqV4cWcYkX7m2nT3p",
  amount: "0.01",
  mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  reference: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...overrides,
});

describe("payment request link", () => {
  it("round-trips a signed payload", async () => {
    const data = payload();
    const token = await signPaymentRequestLink(data, SECRET);
    await expect(verifyPaymentRequestLink(token, SECRET)).resolves.toEqual(data);
  });

  it("accepts a link with no expiry", async () => {
    const data = payload({ expiresAt: null });
    const token = await signPaymentRequestLink(data, SECRET);
    await expect(verifyPaymentRequestLink(token, SECRET)).resolves.toEqual(data);
  });

  it("rejects a tampered body", async () => {
    const token = await signPaymentRequestLink(payload(), SECRET);
    const [body, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload(), amount: "9999" })).toString(
      "base64url"
    );
    await expect(verifyPaymentRequestLink(`${forged}.${signature}`, SECRET)).rejects.toThrow(
      /Invalid payment request link signature/
    );
    expect(body).not.toEqual(forged);
  });

  it("rejects a wrong secret", async () => {
    const token = await signPaymentRequestLink(payload(), SECRET);
    await expect(verifyPaymentRequestLink(token, "other_secret")).rejects.toThrow(
      /Invalid payment request link signature/
    );
  });

  it("rejects an expired link", async () => {
    const data = payload({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const token = await signPaymentRequestLink(data, SECRET);
    await expect(verifyPaymentRequestLink(token, SECRET)).rejects.toThrow(/has expired/);
  });

  it("rejects a malformed token", async () => {
    await expect(verifyPaymentRequestLink("not-a-token", SECRET)).rejects.toThrow(
      /Malformed payment request link/
    );
  });
});

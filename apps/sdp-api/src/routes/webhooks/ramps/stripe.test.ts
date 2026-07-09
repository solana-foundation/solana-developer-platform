import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StripeWebhookProcessor } from "./stripe";

const STRIPE_ENV = {
  STRIPE_WEBHOOK_SECRET: "whsec_test",
};

function signStripeBody(rawBody: string, timestamp: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

describe("StripeWebhookProcessor", () => {
  it("maps onramp session statuses to settlement event kinds", () => {
    const processor = new StripeWebhookProcessor();
    const event = (status: string, extra?: Record<string, unknown>) => ({
      type: "crypto.onramp_session.updated",
      data: { object: extra ? { id: "cos_1", status, ...extra } : { id: "cos_1", status } },
    });

    expect(processor.parse(event("requires_payment"))).toMatchObject({
      kind: "awaiting_payment",
      reference: "cos_1",
    });
    expect(processor.parse(event("fulfillment_processing"))).toMatchObject({
      kind: "settling",
    });
    expect(
      processor.parse(
        event("fulfillment_complete", { transaction_details: { destination_amount: "0.5" } })
      )
    ).toMatchObject({ kind: "settled", reference: "cos_1", receivedAmount: "0.5" });
    expect(processor.parse(event("rejected"))).toMatchObject({ kind: "failed" });
    expect(processor.parse(event("initialized"))).toMatchObject({ kind: "ignore" });
    expect(processor.parse({ type: "crypto.onramp_session.created", data: {} })).toMatchObject({
      kind: "ignore",
    });
  });

  it("throws on a known event type with a malformed envelope", () => {
    const processor = new StripeWebhookProcessor();
    expect(() => processor.parse({ type: "crypto.onramp_session.updated", data: {} })).toThrow(
      "missing the session object"
    );
    expect(() =>
      processor.parse({
        type: "crypto.onramp_session.updated",
        data: { object: { status: "rejected" } },
      })
    ).toThrow("missing the session id");
  });

  it("accepts a correctly signed webhook and rejects a forged one", async () => {
    const processor = new StripeWebhookProcessor();
    const rawBody = JSON.stringify({ type: "crypto.onramp_session.updated", data: {} });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signStripeBody(rawBody, timestamp, "whsec_test");

    const payload = await processor.verify({
      env: STRIPE_ENV,
      environment: "sandbox",
      headers: new Headers({ "stripe-signature": `t=${timestamp},v1=${signature}` }),
      rawBody,
    });
    expect(payload).toEqual({ type: "crypto.onramp_session.updated", data: {} });

    await expect(
      processor.verify({
        env: STRIPE_ENV,
        environment: "sandbox",
        headers: new Headers({ "stripe-signature": `t=${timestamp},v1=deadbeef` }),
        rawBody,
      })
    ).rejects.toThrow(/Invalid stripe webhook signature/);

    await expect(
      processor.verify({
        env: STRIPE_ENV,
        environment: "sandbox",
        headers: new Headers({}),
        rawBody,
      })
    ).rejects.toThrow(/missing the Stripe-Signature header/);
  });

  it("rejects a correctly signed but stale webhook", async () => {
    const processor = new StripeWebhookProcessor();
    const rawBody = JSON.stringify({ type: "crypto.onramp_session.updated", data: {} });
    const staleTimestamp = (Math.floor(Date.now() / 1000) - 3600).toString();
    const signature = signStripeBody(rawBody, staleTimestamp, "whsec_test");

    await expect(
      processor.verify({
        env: STRIPE_ENV,
        environment: "sandbox",
        headers: new Headers({ "stripe-signature": `t=${staleTimestamp},v1=${signature}` }),
        rawBody,
      })
    ).rejects.toThrow(/tolerance window/i);
  });
});

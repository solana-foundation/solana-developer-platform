import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StripeWebhookProcessor } from "./stripe";

const STRIPE_ENV = {
  STRIPE_SANDBOX_WEBHOOK_SECRET: "whsec_test",
};

function signStripeBody(rawBody: string, timestamp: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** Verifies `body` signed with the sandbox secret at the `environment` endpoint. */
function verifySigned(body: Record<string, unknown>, environment: "sandbox" | "production") {
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signStripeBody(rawBody, timestamp, "whsec_test");
  return new StripeWebhookProcessor().verify({
    env: STRIPE_ENV,
    environment,
    headers: new Headers({ "stripe-signature": `t=${timestamp},v1=${signature}` }),
    rawBody,
  });
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
        event("fulfillment_complete", {
          transaction_details: {
            destination_amount: "0.5",
            destination_currency: "usdc",
            destination_network: "solana",
          },
        })
      )
    ).toMatchObject({ kind: "settled", reference: "cos_1", receivedAmount: "0.5" });
    expect(processor.parse(event("rejected"))).toMatchObject({ kind: "failed" });
    expect(processor.parse(event("initialized"))).toMatchObject({ kind: "ignore" });
    expect(processor.parse({ type: "crypto.onramp_session.created", data: {} })).toMatchObject({
      kind: "ignore",
    });
  });

  it("reports the rail a completed session delivered, null for an asset SDP does not sell", () => {
    const processor = new StripeWebhookProcessor();
    const completed = (transactionDetails: Record<string, unknown>) =>
      processor.parse({
        type: "crypto.onramp_session.updated",
        data: {
          object: {
            id: "cos_1",
            status: "fulfillment_complete",
            transaction_details: transactionDetails,
          },
        },
      });

    expect(
      completed({ destination_currency: "usdc", destination_network: "solana" })
    ).toMatchObject({ kind: "settled", deliveredAssetRail: "usdc.solana" });
    expect(completed({ destination_currency: "sol", destination_network: "solana" })).toMatchObject(
      { deliveredAssetRail: "sol.solana" }
    );
    expect(
      completed({ destination_currency: "eth", destination_network: "ethereum" })
    ).toMatchObject({ deliveredAssetRail: null });
  });

  it("throws on a completed session without its destination currency or network", () => {
    const processor = new StripeWebhookProcessor();
    const completed = (transactionDetails?: Record<string, unknown>) => () =>
      processor.parse({
        type: "crypto.onramp_session.updated",
        data: {
          object: {
            id: "cos_1",
            status: "fulfillment_complete",
            transaction_details: transactionDetails,
          },
        },
      });

    expect(completed()).toThrow("destination currency or network");
    expect(completed({ destination_amount: "0.5" })).toThrow("destination currency or network");
    expect(completed({ destination_currency: 7, destination_network: "solana" })).toThrow(
      "destination currency or network"
    );
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
    expect(() =>
      processor.parse({ type: "crypto.onramp_session.updated", data: { object: { id: "cos_1" } } })
    ).toThrow("missing the session status");
  });

  it("accepts a correctly signed webhook and rejects a forged one", async () => {
    const processor = new StripeWebhookProcessor();
    const rawBody = JSON.stringify({
      type: "crypto.onramp_session.updated",
      livemode: false,
      data: {},
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signStripeBody(rawBody, timestamp, "whsec_test");

    const payload = await processor.verify({
      env: STRIPE_ENV,
      environment: "sandbox",
      headers: new Headers({ "stripe-signature": `t=${timestamp},v1=${signature}` }),
      rawBody,
    });
    expect(payload).toEqual({
      type: "crypto.onramp_session.updated",
      livemode: false,
      data: {},
    });

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
    const rawBody = JSON.stringify({
      type: "crypto.onramp_session.updated",
      livemode: false,
      data: {},
    });
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

  it("refuses a live event at the sandbox endpoint", async () => {
    await expect(
      verifySigned({ type: "crypto.onramp_session.updated", livemode: true, data: {} }, "sandbox")
    ).rejects.toThrow("Stripe live event sent to the sandbox webhook");
  });

  it("refuses an event that does not say which mode it ran in", async () => {
    await expect(
      verifySigned({ type: "crypto.onramp_session.updated", data: {} }, "sandbox")
    ).rejects.toThrow("Stripe webhook is missing livemode");
  });

  it("refuses the production endpoint, which has no managed secret", async () => {
    await expect(
      verifySigned(
        { type: "crypto.onramp_session.updated", livemode: true, data: {} },
        "production"
      )
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
  });
});

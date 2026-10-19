import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { stripeWebhook } from "@/services/ramps/webhooks/stripe";

const STRIPE_ENV = {
  STRIPE_SANDBOX_WEBHOOK_SECRET: "whsec_test",
};

function signStripeBody(rawBody: string, timestamp: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

function parseStripeEvent(body: Record<string, unknown>) {
  return stripeWebhook.parse(JSON.stringify(body));
}

/** Verifies `body` signed with the sandbox secret at the `environment` endpoint. */
async function verifySigned(body: Record<string, unknown>, environment: "sandbox" | "production") {
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signStripeBody(rawBody, timestamp, "whsec_test");
  await stripeWebhook.verify({
    env: STRIPE_ENV,
    environment,
    headers: new Headers({ "stripe-signature": `t=${timestamp},v1=${signature}` }),
    rawBody,
  });
  return stripeWebhook.parse(rawBody, environment);
}

describe("stripeWebhook", () => {
  it("uses only Stripe delivery ids for deduplication", () => {
    expect(stripeWebhook.eventId('{"id":"evt_123AbC"}')).toBe("evt_123AbC");
    expect(stripeWebhook.eventId('{"id":"cos_session"}')).toBeNull();
    expect(stripeWebhook.eventId("{bad-json")).toBeNull();
  });

  it("maps onramp session statuses to settlement event kinds", () => {
    const event = (status: string, extra?: Record<string, unknown>) => ({
      type: "crypto.onramp_session.updated",
      data: { object: extra ? { id: "cos_1", status, ...extra } : { id: "cos_1", status } },
    });

    expect(parseStripeEvent(event("requires_payment"))).toMatchObject({
      kind: "awaiting_payment",
      reference: "cos_1",
    });
    expect(parseStripeEvent(event("fulfillment_processing"))).toMatchObject({
      kind: "settling",
    });
    expect(
      parseStripeEvent(
        event("fulfillment_complete", {
          transaction_details: {
            destination_amount: "0.5",
            destination_currency: "usdc",
            destination_network: "solana",
          },
        })
      )
    ).toMatchObject({ kind: "settled", reference: "cos_1", receivedAmount: "0.5" });
    expect(parseStripeEvent(event("rejected"))).toMatchObject({ kind: "failed" });
    expect(parseStripeEvent(event("initialized"))).toMatchObject({ kind: "ignore" });
    expect(parseStripeEvent({ type: "crypto.onramp_session.created", data: {} })).toMatchObject({
      kind: "ignore",
    });
  });

  it("reports the rail a completed session delivered, null for an asset SDP does not sell", () => {
    const completed = (transactionDetails: Record<string, unknown>) =>
      parseStripeEvent({
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
    const completed = (transactionDetails?: Record<string, unknown>) => () =>
      parseStripeEvent({
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
    expect(() => parseStripeEvent({ type: "crypto.onramp_session.updated", data: {} })).toThrow(
      "missing the session object"
    );
    expect(() =>
      parseStripeEvent({
        type: "crypto.onramp_session.updated",
        data: { object: { status: "rejected" } },
      })
    ).toThrow("missing the session id");
    expect(() =>
      parseStripeEvent({ type: "crypto.onramp_session.updated", data: { object: { id: "cos_1" } } })
    ).toThrow("missing the session status");
  });

  it("accepts a correctly signed webhook and rejects a forged one", async () => {
    const processor = stripeWebhook;
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
    expect(payload).toBe(rawBody);

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
    const processor = stripeWebhook;
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

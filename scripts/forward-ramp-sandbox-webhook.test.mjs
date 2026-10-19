import assert from "node:assert/strict";
import { test } from "node:test";
import {
  localStripeEventId,
  moonpaySignatureHeader,
  moonpayWebhookBody,
  stripeEventBody,
  stripeSignatureHeader,
} from "./forward-ramp-sandbox-webhook.mjs";

test("signs MoonPay bodies over `timestamp.body`, as the API verifies them", () => {
  assert.equal(
    moonpaySignatureHeader("moonpay-test-key", 1700000000, '{"type":"transaction_updated"}'),
    // biome-ignore lint/security/noSecrets: HMAC of a synthetic fixture key, not a real key.
    "t=1700000000,s=b6cbfe84a94204a6858ad66a643fbd1eb369c8f81d764347b885e56a172e102e"
  );
});

test("signs Stripe events over `timestamp.body` with a v1 signature", () => {
  assert.equal(
    stripeSignatureHeader("whsec_test", 1700000000, '{"id":"evt_test"}'),
    // biome-ignore lint/security/noSecrets: HMAC of a synthetic fixture key, not a real key.
    "t=1700000000,v1=14c4f43763339dcb1c15f41a1ff31a94f2f09f8de278f8b4392ca0d7cbcd257e"
  );
});

for (const { direction, status, type } of [
  { direction: "onramp", status: "pending", type: "transaction_updated" },
  { direction: "onramp", status: "failed", type: "transaction_failed" },
  { direction: "offramp", status: "waitingForDeposit", type: "sell_transaction_updated" },
  { direction: "offramp", status: "failed", type: "sell_transaction_failed" },
]) {
  test(`wraps a MoonPay ${direction} record in ${status} as ${type}`, () => {
    const transaction = { id: "mp_1", status, externalCustomerId: "cpty_1" };

    assert.deepEqual(JSON.parse(moonpayWebhookBody(direction, transaction)), {
      type,
      data: transaction,
      externalCustomerId: "cpty_1",
    });
  });
}

test("keeps a MoonPay record without a customer id as an explicit null", () => {
  assert.equal(
    JSON.parse(moonpayWebhookBody("onramp", { id: "mp_1", status: "pending" })).externalCustomerId,
    null
  );
});

test("wraps a Stripe session as the event the inbox accepts", () => {
  const eventId = localStripeEventId();
  const session = { id: "cos_1", status: "fulfillment_complete", livemode: false };

  assert.match(eventId, /^evt_[A-Za-z0-9]+$/);
  assert.deepEqual(JSON.parse(stripeEventBody(session, eventId, 1700000000)), {
    id: eventId,
    object: "event",
    type: "crypto.onramp_session.updated",
    livemode: false,
    created: 1700000000,
    data: { object: session },
  });
});

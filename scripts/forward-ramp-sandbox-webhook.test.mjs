import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  localStripeEventId,
  moonpayEnvSchema,
  moonpayLookupSchema,
  moonpaySignatureHeader,
  moonpayWebhookBody,
  parseInput,
  postWebhook,
  stripeEventBody,
  stripeOnrampSessionSchema,
  stripeSignatureHeader,
} from "./forward-ramp-sandbox-webhook.mjs";

/** A stand-in for the local API that answers every request with `status` and `answer`. */
async function startLocalApi(t, status, answer) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(answer);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

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

test("forwards a MoonPay record whole, not only the fields it checks", () => {
  const record = {
    id: "mp_1",
    status: "completed",
    updatedAt: "2026-10-19T12:00:00.000+02:00",
    depositHash: "sig_1",
    depositWallet: { walletAddress: "wallet_1" },
  };

  assert.deepEqual(parseInput("MoonPay lookup", moonpayLookupSchema, [record]), [record]);
});

test("refuses a MoonPay record it can't order", () => {
  assert.throws(
    () => parseInput("MoonPay lookup", moonpayLookupSchema, [{ id: "mp_1", status: "pending" }]),
    /MoonPay lookup is invalid: .*\[0\]\.updatedAt/
  );
});

test("refuses a live-mode Stripe session", () => {
  const session = { id: "cos_1", status: "fulfillment_complete", livemode: true };

  assert.throws(
    () => parseInput("Stripe onramp session", stripeOnrampSessionSchema, session),
    /Stripe onramp session is invalid: .*livemode/
  );
});

test("names a bad environment key without printing any key", () => {
  const env = {
    MOONPAY_SANDBOX_API_KEY: "fixture-api-key-value",
    MOONPAY_SANDBOX_WEBHOOK_KEY: " ",
    SDP_API_URL: "not a url",
  };

  assert.throws(
    () => parseInput("environment", moonpayEnvSchema, env),
    (error) => {
      assert.match(error.message, /MOONPAY_SANDBOX_WEBHOOK_KEY/);
      assert.match(error.message, /SDP_API_URL/);
      assert.doesNotMatch(error.message, /fixture-api-key-value/);
      return true;
    }
  );
});

test("defaults SDP_API_URL to the local API", () => {
  const env = parseInput("environment", moonpayEnvSchema, {
    MOONPAY_SANDBOX_API_KEY: "fixture-api-key",
    MOONPAY_SANDBOX_WEBHOOK_KEY: "fixture-webhook-key",
  });

  assert.equal(env.SDP_API_URL, "http://127.0.0.1:8787");
});

test("posts the signed body to the provider's sandbox webhook", async (t) => {
  const api = await startLocalApi(t, 200, '{"received":true}');

  const outcome = await postWebhook(api.url, "moonpay", '{"type":"transaction_updated"}', {
    "moonpay-signature-v2": "t=1700000000,s=00",
  });

  assert.equal(outcome, 'HTTP 200 {"received":true}');
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].method, "POST");
  assert.equal(api.requests[0].url, "/webhooks/payments/ramps/sandbox/moonpay");
  assert.equal(api.requests[0].headers["moonpay-signature-v2"], "t=1700000000,s=00");
  assert.equal(api.requests[0].body, '{"type":"transaction_updated"}');
});

test("throws when the API refuses a webhook, so a failed replay exits non-zero", async (t) => {
  const api = await startLocalApi(t, 401, '{"error":"invalid signature"}');

  await assert.rejects(
    postWebhook(api.url, "stripe", '{"id":"evt_1"}', { "stripe-signature": "t=1700000000,v1=00" }),
    /stripe webhook rejected: HTTP 401 \{"error":"invalid signature"\}/
  );
});

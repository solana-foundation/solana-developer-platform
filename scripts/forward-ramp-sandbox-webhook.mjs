// Forwards a ramp provider's sandbox record to the local SDP API as the signed
// webhook the provider would have sent. MoonPay's sandbox delivers webhooks
// only to the URLs in its dashboard, and Stripe's sandbox account emits no
// onramp events, so a local run replays the provider's own record instead of
// inventing one. See docs/testing/ramps-sandbox.md.
//
//   node scripts/forward-ramp-sandbox-webhook.mjs moonpay <xfr_transferId>
//   node scripts/forward-ramp-sandbox-webhook.mjs stripe <cos_sessionId>
//
// Reads MOONPAY_SANDBOX_API_KEY and MOONPAY_SANDBOX_WEBHOOK_KEY, or
// STRIPE_SANDBOX_SECRET_KEY and STRIPE_SANDBOX_WEBHOOK_SECRET (the values the
// running API verifies with), and SDP_API_URL (default http://127.0.0.1:8787).
// Never prints a key.
import { createHmac, randomBytes } from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MOONPAY_API_URL = "https://api.moonpay.com";
const STRIPE_API_URL = "https://api.stripe.com";
// Keep in step with STRIPE_API_VERSION in packages/sdp-payments/src/ramps/providers/stripe/client.ts.
const STRIPE_API_VERSION = "2026-05-27.dahlia";
const DEFAULT_SDP_API_URL = "http://127.0.0.1:8787";

/** Where MoonPay looks a transfer's buys and sales up by the external id SDP signs into the widget. */
const MOONPAY_LOOKUP_PATHS = {
  onramp: "/v1/transactions/ext",
  offramp: "/v3/sell_transactions/ext",
};

function hmacHex(key, timestamp, body) {
  return createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");
}

/** The `moonpay-signature-v2` header MoonPay signs a webhook body with. */
export function moonpaySignatureHeader(key, timestamp, body) {
  return `t=${timestamp},s=${hmacHex(key, timestamp, body)}`;
}

/** The `stripe-signature` header Stripe signs an event body with. */
export function stripeSignatureHeader(secret, timestamp, body) {
  return `t=${timestamp},v1=${hmacHex(secret, timestamp, body)}`;
}

/** The webhook MoonPay sends for one buy or sale in its current state. */
export function moonpayWebhookBody(direction, transaction) {
  const kind = direction === "offramp" ? "sell_transaction" : "transaction";
  const change = transaction.status === "failed" ? "failed" : "updated";
  return JSON.stringify({
    type: `${kind}_${change}`,
    data: transaction,
    externalCustomerId: transaction.externalCustomerId ?? null,
  });
}

/** A fresh event id in the shape the Stripe inbox accepts (`evt_` and letters or digits). */
export function localStripeEventId() {
  return `evt_localforward${randomBytes(8).toString("hex")}`;
}

/** The `crypto.onramp_session.updated` event Stripe sends for one session. */
export function stripeEventBody(session, eventId, createdSeconds) {
  return JSON.stringify({
    id: eventId,
    object: "event",
    type: "crypto.onramp_session.updated",
    livemode: session.livemode,
    created: createdSeconds,
    data: { object: session },
  });
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

async function readJson(response, source) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${source} answered ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function postWebhook(provider, body, signatureHeader) {
  const baseUrl =
    process.env.SDP_API_URL === undefined ? DEFAULT_SDP_API_URL : process.env.SDP_API_URL;
  const response = await fetch(`${baseUrl}/webhooks/payments/ramps/sandbox/${provider}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signatureHeader },
    body,
  });
  return `HTTP ${response.status} ${(await response.text()).slice(0, 300)}`;
}

async function moonpayRecords(transferId) {
  const apiKey = requireEnv("MOONPAY_SANDBOX_API_KEY");
  const records = [];
  for (const [direction, path] of Object.entries(MOONPAY_LOOKUP_PATHS)) {
    const url = `${MOONPAY_API_URL}${path}/${encodeURIComponent(transferId)}?apiKey=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url);
    // MoonPay answers 404 when the transfer has no record in this direction.
    if (response.status === 404) {
      continue;
    }
    for (const transaction of await readJson(response, `MoonPay ${path}`)) {
      records.push({ direction, transaction });
    }
  }
  // Oldest first, so SDP sees each transaction's states in the order MoonPay reached them.
  return records.sort((a, b) => a.transaction.updatedAt.localeCompare(b.transaction.updatedAt));
}

async function forwardMoonpay(transferId) {
  const webhookKey = requireEnv("MOONPAY_SANDBOX_WEBHOOK_KEY");
  const records = await moonpayRecords(transferId);
  if (records.length === 0) {
    throw new Error(`MoonPay's sandbox holds no buy or sale for ${transferId} yet`);
  }
  for (const { direction, transaction } of records) {
    const body = moonpayWebhookBody(direction, transaction);
    const timestamp = Math.floor(Date.now() / 1000);
    const outcome = await postWebhook("moonpay", body, {
      "moonpay-signature-v2": moonpaySignatureHeader(webhookKey, timestamp, body),
    });
    console.log(`moonpay ${direction} ${transaction.id} ${transaction.status} -> ${outcome}`);
  }
}

async function forwardStripe(sessionId) {
  const secretKey = requireEnv("STRIPE_SANDBOX_SECRET_KEY");
  const webhookSecret = requireEnv("STRIPE_SANDBOX_WEBHOOK_SECRET");
  const response = await fetch(
    `${STRIPE_API_URL}/v1/crypto/onramp_sessions/${encodeURIComponent(sessionId)}`,
    { headers: { authorization: `Bearer ${secretKey}`, "Stripe-Version": STRIPE_API_VERSION } }
  );
  const session = await readJson(response, "Stripe onramp session");
  const eventId = localStripeEventId();
  const timestamp = Math.floor(Date.now() / 1000);
  const body = stripeEventBody(session, eventId, timestamp);
  const outcome = await postWebhook("stripe", body, {
    "stripe-signature": stripeSignatureHeader(webhookSecret, timestamp, body),
  });
  console.log(`stripe ${session.id} ${session.status} as ${eventId} -> ${outcome}`);
}

async function main([provider, id]) {
  if (provider === "moonpay" && id?.startsWith("xfr_")) {
    await forwardMoonpay(id);
    return;
  }
  if (provider === "stripe" && id?.startsWith("cos_")) {
    await forwardStripe(id);
    return;
  }
  throw new Error(
    "usage: forward-ramp-sandbox-webhook.mjs moonpay <xfr_transferId> | stripe <cos_sessionId>"
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  });
}

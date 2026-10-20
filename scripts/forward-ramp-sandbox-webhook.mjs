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
import { z } from "zod";

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

const nonBlankStringSchema = z.string().regex(/\S/, "must not be blank");
const sdpApiUrlSchema = z.url().default(DEFAULT_SDP_API_URL);

/** The environment a MoonPay replay reads, parsed before its first request. */
export const moonpayEnvSchema = z.object({
  MOONPAY_SANDBOX_API_KEY: nonBlankStringSchema,
  MOONPAY_SANDBOX_WEBHOOK_KEY: nonBlankStringSchema,
  SDP_API_URL: sdpApiUrlSchema,
});

/** The environment a Stripe replay reads, parsed before its first request. */
export const stripeEnvSchema = z.object({
  STRIPE_SANDBOX_SECRET_KEY: nonBlankStringSchema,
  STRIPE_SANDBOX_WEBHOOK_SECRET: nonBlankStringSchema,
  SDP_API_URL: sdpApiUrlSchema,
});

/**
 * Every buy or every sale MoonPay holds for one external id. Only the fields
 * this script reads are checked, as the API's MoonPay schemas check them
 * (packages/sdp-payments/src/ramps/providers/moonpay/event-status-mapping.ts).
 * The rest pass through unchanged, so SDP receives every field MoonPay sent.
 */
export const moonpayLookupSchema = z.array(
  z.looseObject({
    id: nonBlankStringSchema,
    status: nonBlankStringSchema,
    externalCustomerId: z.string().nullish(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
);

/**
 * A Stripe onramp session, checked where this script reads it and otherwise
 * forwarded as Stripe returned it. A live-mode session never belongs in the
 * sandbox inbox.
 */
export const stripeOnrampSessionSchema = z.looseObject({
  id: z.string().startsWith("cos_"),
  status: nonBlankStringSchema,
  livemode: z.literal(false),
});

/**
 * Parses external input at the boundary. A failure names the source and each
 * field that failed, never a value, so no key reaches the output.
 */
export function parseInput(source, schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const problems = z.prettifyError(result.error).replace(/\s+/g, " ").trim();
    throw new Error(`${source} is invalid: ${problems}`);
  }
  return result.data;
}

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

async function readProviderRecord(response, source, schema) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${source} answered ${response.status}: ${text.slice(0, 300)}`);
  }
  return parseInput(source, schema, JSON.parse(text));
}

/**
 * Posts one signed webhook to the local API. The API acks every event it
 * verifies with a 2xx, so any other status (a mismatched key, the ramps module
 * off, a server error) throws and the command exits non-zero.
 */
export async function postWebhook(sdpApiUrl, provider, body, signatureHeader) {
  const response = await fetch(`${sdpApiUrl}/webhooks/payments/ramps/sandbox/${provider}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signatureHeader },
    body,
  });
  const outcome = `HTTP ${response.status} ${(await response.text()).slice(0, 300)}`;
  if (!response.ok) {
    throw new Error(`${provider} webhook rejected: ${outcome}`);
  }
  return outcome;
}

async function moonpayRecords(apiKey, transferId) {
  const records = [];
  for (const [direction, path] of Object.entries(MOONPAY_LOOKUP_PATHS)) {
    const url = `${MOONPAY_API_URL}${path}/${encodeURIComponent(transferId)}?apiKey=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url);
    // MoonPay answers 404 when the transfer has no record in this direction.
    if (response.status === 404) {
      continue;
    }
    const transactions = await readProviderRecord(response, `MoonPay ${path}`, moonpayLookupSchema);
    for (const transaction of transactions) {
      records.push({ direction, transaction });
    }
  }
  // Oldest first, so SDP sees each transaction's states in the order MoonPay reached them.
  // Date.parse, as the API orders them: MoonPay's timestamps may carry an offset.
  return records.sort(
    (a, b) => Date.parse(a.transaction.updatedAt) - Date.parse(b.transaction.updatedAt)
  );
}

async function forwardMoonpay(transferId, env) {
  const records = await moonpayRecords(env.MOONPAY_SANDBOX_API_KEY, transferId);
  if (records.length === 0) {
    throw new Error(`MoonPay's sandbox holds no buy or sale for ${transferId} yet`);
  }
  for (const { direction, transaction } of records) {
    const body = moonpayWebhookBody(direction, transaction);
    const timestamp = Math.floor(Date.now() / 1000);
    const outcome = await postWebhook(env.SDP_API_URL, "moonpay", body, {
      "moonpay-signature-v2": moonpaySignatureHeader(
        env.MOONPAY_SANDBOX_WEBHOOK_KEY,
        timestamp,
        body
      ),
    });
    console.log(`moonpay ${direction} ${transaction.id} ${transaction.status} -> ${outcome}`);
  }
}

async function forwardStripe(sessionId, env) {
  const response = await fetch(
    `${STRIPE_API_URL}/v1/crypto/onramp_sessions/${encodeURIComponent(sessionId)}`,
    {
      headers: {
        authorization: `Bearer ${env.STRIPE_SANDBOX_SECRET_KEY}`,
        "Stripe-Version": STRIPE_API_VERSION,
      },
    }
  );
  const session = await readProviderRecord(
    response,
    "Stripe onramp session",
    stripeOnrampSessionSchema
  );
  const eventId = localStripeEventId();
  const timestamp = Math.floor(Date.now() / 1000);
  const body = stripeEventBody(session, eventId, timestamp);
  const outcome = await postWebhook(env.SDP_API_URL, "stripe", body, {
    "stripe-signature": stripeSignatureHeader(env.STRIPE_SANDBOX_WEBHOOK_SECRET, timestamp, body),
  });
  console.log(`stripe ${session.id} ${session.status} as ${eventId} -> ${outcome}`);
}

async function main([provider, id]) {
  if (provider === "moonpay" && id?.startsWith("xfr_")) {
    await forwardMoonpay(id, parseInput("environment", moonpayEnvSchema, process.env));
    return;
  }
  if (provider === "stripe" && id?.startsWith("cos_")) {
    await forwardStripe(id, parseInput("environment", stripeEnvSchema, process.env));
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

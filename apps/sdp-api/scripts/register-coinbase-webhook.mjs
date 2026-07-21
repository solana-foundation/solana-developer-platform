#!/usr/bin/env node

import { generateJwt } from "@coinbase/cdp-sdk/auth";

const [webhookUrl, description = "SDP onramp events"] = process.argv.slice(2);
const apiKeyId = process.env.COINBASE_CDP_API_KEY_ID;
const apiKeySecret = process.env.COINBASE_CDP_API_KEY_SECRET;

if (!webhookUrl || !apiKeyId || !apiKeySecret) {
  console.error("usage: doppler run -- node register-coinbase-webhook.mjs <webhook-url>");
  console.error("arguments:");
  console.error("<webhook-url> the deployed /webhooks/payments/ramps/<mode>/coinbase endpoint");
  console.error("description optional");
  console.error("requires COINBASE_CDP_API_KEY_ID and COINBASE_CDP_API_KEY_SECRET in the env");
  process.exit(1);
}

const EVENT_TYPES = [
  "onramp.transaction.created",
  "onramp.transaction.updated",
  "onramp.transaction.success",
  "onramp.transaction.failed",
];

const HOST = "api.cdp.coinbase.com";
const SUBSCRIPTIONS_PATH = "/platform/v2/data/webhooks/subscriptions";

async function cdpApi(method, path, body) {
  const jwt = await generateJwt({
    apiKeyId,
    apiKeySecret,
    requestMethod: method,
    requestHost: HOST,
    requestPath: path,
  });
  const response = await fetch(`https://${HOST}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : undefined;
}

const subscriptionBody = {
  description,
  eventTypes: EVENT_TYPES,
  isEnabled: true,
  target: { url: webhookUrl },
};

const { subscriptions } = await cdpApi("GET", SUBSCRIPTIONS_PATH);
const existing = subscriptions.find(
  (entry) => entry.target.url.replace(/\/$/, "") === webhookUrl.replace(/\/$/, "")
);

let subscription;
if (existing) {
  console.log(
    `Reusing existing subscription ${existing.subscriptionId} for ${webhookUrl}; syncing event types`
  );
  subscription = await cdpApi(
    "PUT",
    `${SUBSCRIPTIONS_PATH}/${existing.subscriptionId}`,
    subscriptionBody
  );
} else {
  subscription = await cdpApi("POST", SUBSCRIPTIONS_PATH, subscriptionBody);
  console.log(`Created subscription ${subscription.subscriptionId}`);
}

console.log(`Subscription ${subscription.subscriptionId} -> ${subscription.target.url}`);
console.log(`Event types: ${subscription.eventTypes.join(", ")}`);
console.log("\nStore this in your secret store as COINBASE_CDP_RAMPS_WEBHOOK_SECRET:");
console.log("------------------------------------------------------------");
console.log(subscription.secret);
console.log("------------------------------------------------------------");

#!/usr/bin/env node

const [apiKey, webhookUrl, environment = "sandbox"] = process.argv.slice(2);

if (!apiKey || !webhookUrl) {
  console.error("usage: register-mural-webhook.mjs");
  console.error("arguments:");
  console.error("<api-key>");
  console.error("<webhook-url>");
  console.error("mode optional");
  process.exit(1);
}

const CATEGORIES = [
  "MURAL_ACCOUNT_BALANCE_ACTIVITY",
  "BUSINESS_VERIFICATION_STATUS",
  "ORGANIZATION_TOS",
  "PAYOUT_REQUEST",
  "PAYIN",
  "COMPLIANCE_REVIEW",
];

const isProduction = environment === "production";
const baseUrl = isProduction ? "https://api.muralpay.com" : "https://api-staging.muralpay.com";
const keyVar = isProduction
  ? "MURAL_PAY_WEBHOOK_PUBLIC_KEY"
  : "MURAL_PAY_SANDBOX_WEBHOOK_PUBLIC_KEY";

async function muralApi(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : undefined;
}

const existing = await muralApi("GET", "/api/webhooks");
let webhook = existing.find((entry) => entry.url === webhookUrl);

if (webhook) {
  console.log(`Reusing existing webhook ${webhook.id} for ${webhookUrl}; syncing categories`);
  webhook = await muralApi("PATCH", `/api/webhooks/${webhook.id}`, { categories: CATEGORIES });
} else {
  webhook = await muralApi("POST", "/api/webhooks", { url: webhookUrl, categories: CATEGORIES });
  console.log(`Created webhook ${webhook.id}`);
}

await muralApi("PATCH", `/api/webhooks/${webhook.id}/status`, { status: "ACTIVE" });
console.log(`Webhook ${webhook.id} is ACTIVE (categories: ${CATEGORIES.join(", ")})`);

console.log(`\nStore this in your secret store as ${keyVar}:`);
console.log("------------------------------------------------------------");
console.log(webhook.publicKey);
console.log("------------------------------------------------------------");

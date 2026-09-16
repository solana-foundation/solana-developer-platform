/**
 * Webhook Routes
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { payloadTooLarge } from "@/lib/errors";
import { localRateLimit } from "@/middleware/local-rate-limit";
import type { Env } from "@/types/env";
import { handleClerkWebhook, handleRampProviderWebhook } from "./handlers";

// Provider webhook payloads are a few kilobytes; the handlers buffer the body
// whole to verify its signature, so the ceiling is what bounds that buffer.
const MAX_BODY_BYTES = 1024 * 1024;

// These routes are deliberately outside the KV-backed limiter — a provider's
// delivery has to survive KV being down — which left them with no limit at
// all. Per instance, per verified source address.
const MAX_REQUESTS_PER_MINUTE = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_TRACKED_ADDRESSES = 4096;

const webhooks = new Hono<{ Bindings: Env }>();

webhooks.use(
  "*",
  localRateLimit({
    name: "webhooks",
    maxRequests: MAX_REQUESTS_PER_MINUTE,
    windowMs: RATE_LIMIT_WINDOW_MS,
    maxTrackedKeys: MAX_TRACKED_ADDRESSES,
  })
);

webhooks.use(
  "*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw payloadTooLarge();
    },
  })
);

webhooks.post("/clerk/link-orgs", handleClerkWebhook);
webhooks.post("/payments/ramps/sandbox/:provider", (c) => handleRampProviderWebhook(c, "sandbox"));
webhooks.post("/payments/ramps/production/:provider", (c) =>
  handleRampProviderWebhook(c, "production")
);

export default webhooks;

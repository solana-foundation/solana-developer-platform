/**
 * Webhook Routes
 */

import { Hono } from "hono";
import type { Env } from "@/types/env";
import { handleClerkWebhook, handleRampProviderWebhook } from "./handlers";

const webhooks = new Hono<{ Bindings: Env }>();

webhooks.post("/clerk/link-orgs", handleClerkWebhook);
webhooks.post("/payments/ramps/sandbox/:provider", (c) => handleRampProviderWebhook(c, "sandbox"));
webhooks.post("/payments/ramps/production/:provider", (c) =>
  handleRampProviderWebhook(c, "production")
);

export default webhooks;

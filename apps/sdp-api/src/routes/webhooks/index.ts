/**
 * Webhook Routes
 */

import type { Env } from "@/types/env";
import { Hono } from "hono";
import { handleClerkWebhook } from "./handlers";

const webhooks = new Hono<{ Bindings: Env }>();

webhooks.post("/clerk", handleClerkWebhook);
// Alias for clearer intent (org linking). Keep `/clerk` for backwards compatibility.
webhooks.post("/clerk/link-orgs", handleClerkWebhook);

export default webhooks;

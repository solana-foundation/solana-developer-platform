/**
 * Webhook Routes
 */

import type { Env } from "@/types/env";
import { Hono } from "hono";
import { handleClerkWebhook } from "./handlers";

const webhooks = new Hono<{ Bindings: Env }>();

webhooks.post("/clerk", handleClerkWebhook);

export default webhooks;

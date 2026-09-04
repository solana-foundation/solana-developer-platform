import type { Context } from "hono";
import { Hono, type Next } from "hono";
import { AppError } from "@/lib/errors";
import { isAssetProfilesEnabled } from "@/lib/feature-flags";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import type { Env } from "@/types/env";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  redeliverWebhookDelivery,
  rotateWebhookEndpointSecret,
  updateWebhookEndpoint,
} from "./handlers";

const webhookEndpoints = new Hono<{ Bindings: Env }>();

webhookEndpoints.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
webhookEndpoints.use("*", projectContextMiddleware());

// The registry only serves workflow send_webhook rules, which are the asset-profiles
// feature surface — same gate as the workflow routes so a flag-off deployment can't
// accumulate endpoints its engine will never deliver to.
webhookEndpoints.use("*", async (c: Context<{ Bindings: Env }>, next: Next) => {
  if (!isAssetProfilesEnabled(c.env)) {
    throw new AppError("FORBIDDEN", "Asset Profiles are not enabled for this environment");
  }
  await next();
});

webhookEndpoints.get("/", requirePermissions("webhooks:read"), listWebhookEndpoints);
webhookEndpoints.post("/", requirePermissions("webhooks:write"), createWebhookEndpoint);
webhookEndpoints.get("/:endpointId", requirePermissions("webhooks:read"), getWebhookEndpoint);
webhookEndpoints.patch("/:endpointId", requirePermissions("webhooks:write"), updateWebhookEndpoint);
webhookEndpoints.delete(
  "/:endpointId",
  requirePermissions("webhooks:write"),
  deleteWebhookEndpoint
);
webhookEndpoints.post(
  "/:endpointId/rotate-secret",
  requirePermissions("webhooks:write"),
  rotateWebhookEndpointSecret
);
webhookEndpoints.get(
  "/:endpointId/deliveries",
  requirePermissions("webhooks:read"),
  listWebhookDeliveries
);
// Redeliver causes outbound traffic from SDP's egress, so it sits behind write.
webhookEndpoints.post(
  "/:endpointId/deliveries/:deliveryId/redeliver",
  requirePermissions("webhooks:write"),
  redeliverWebhookDelivery
);

export default webhookEndpoints;

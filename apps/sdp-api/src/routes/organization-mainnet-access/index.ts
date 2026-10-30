import { Hono } from "hono";
import { requireHumanSession } from "@/middleware/human-session";
import { meteredQuota } from "@/middleware/metered-quota";
import { requireAction } from "@/middleware/require-action";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { getMainnetAccess, requestMainnetAccess } from "./handlers";
import { requestMainnetAccessSchema } from "./schemas";

// Mounted under /organizations/:orgId/mainnet-access; the parent router applies auth.
// Mainnet access (HOO-2427) is asked for from the dashboard's organization settings: an admin's
// own act, binding the organization to the Terms and Conditions, so never an API key. Only
// admins see the settings card, so its read is administration too.
export const organizationMainnetAccess = new Hono<{ Bindings: Env }>();

organizationMainnetAccess.get(
  "/",
  requireHumanSession(),
  requireAction("organizations.manage"),
  getMainnetAccess
);
// Each submit may email the SDP alias through Resend: one request needs one, a resend of an
// unsent one a few more.
organizationMainnetAccess.post(
  "/",
  requireHumanSession(),
  requireAction("organizations.manage"),
  meteredQuota({ name: "mainnet-access-request", actorMax: 5, orgMax: 10 }),
  validateBody(requestMainnetAccessSchema),
  requestMainnetAccess
);

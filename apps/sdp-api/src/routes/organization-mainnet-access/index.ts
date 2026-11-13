import { Hono } from "hono";
import { requireHumanSession } from "@/middleware/human-session";
import { meteredQuota } from "@/middleware/metered-quota";
import { requireAction } from "@/middleware/require-action";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { getMainnetAccess, notifyMainnetAccess, requestMainnetAccess } from "./handlers";
import { requestMainnetAccessSchema } from "./schemas";

// Mounted under /organizations/:orgId/mainnet-access; the parent router applies auth.
// Mainnet access (HOO-2427) is asked for from the dashboard's organization settings: an admin's
// own act, binding the organization to the Terms and Conditions, so never an API key. Every
// signed-in member reads where it stands: on a deployment that serves mainnet only, the dashboard
// decides from it where a member lands (Production, or the mainnet request page).
export const organizationMainnetAccess = new Hono<{ Bindings: Env }>();

// The action first, as every read an API key may be granted checks it; a key holding it is still
// refused, by the human-session check after it.
organizationMainnetAccess.get(
  "/",
  requireAction("organizations.read"),
  requireHumanSession(),
  getMainnetAccess
);
// Both writes may email the SDP alias through Iterable, so they share one budget: a request needs
// one email, a resend of an unsent one a few more.
const sendQuota = meteredQuota({ name: "mainnet-access-request", actorMax: 5, orgMax: 10 });

organizationMainnetAccess.post(
  "/",
  requireHumanSession(),
  requireAction("organizations.manage"),
  sendQuota,
  validateBody(requestMainnetAccessSchema),
  requestMainnetAccess
);
organizationMainnetAccess.post(
  "/notify",
  requireHumanSession(),
  requireAction("organizations.manage"),
  sendQuota,
  notifyMainnetAccess
);

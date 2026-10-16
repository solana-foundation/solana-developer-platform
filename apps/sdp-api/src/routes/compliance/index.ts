import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { authorizeNone } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { meteredQuota } from "@/middleware/metered-quota";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { screenAddress } from "./handlers";
import { screenAddressSchema } from "./schemas";

const compliance = new Hono<{ Bindings: Env }>();

/** Why screening runs `authorizeNone` (the route inventory pins it). */
export const SCREENS_AN_ADDRESS =
  "screens an on-chain address the caller supplies; it names no resource of any project";

compliance.use("*", unifiedAuthMiddleware());
compliance.use("*", projectContextMiddleware());

// Uses payments read permission so existing dashboard roles can call this endpoint.
// One request bills every enabled compliance vendor, hence the tight quota.
compliance.post(
  "/address-screenings",
  requirePermissions("payments:read"),
  validateBody(screenAddressSchema),
  authorizeNone(SCREENS_AN_ADDRESS),
  // Before the quota, so a replayed screening is never billed again.
  idempotent({ key: "accepted", serverErrors: "store" }),
  meteredQuota({ name: "compliance-screening", actorMax: 30, orgMax: 120 }),
  screenAddress
);

export default compliance;

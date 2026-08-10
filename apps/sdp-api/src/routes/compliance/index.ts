import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { meteredQuota } from "@/middleware/metered-quota";
import { projectContextMiddleware } from "@/middleware/project-context";
import type { Env } from "@/types/env";
import { screenAddress } from "./handlers";

const compliance = new Hono<{ Bindings: Env }>();

compliance.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
compliance.use("*", projectContextMiddleware());

// Uses payments read permission so existing dashboard roles can call this endpoint.
// One request bills every enabled compliance vendor, hence the tight quota.
compliance.post(
  "/address-screenings",
  requirePermissions("payments:read"),
  meteredQuota({ name: "compliance-screening", actorMax: 30, orgMax: 120 }),
  screenAddress
);

export default compliance;

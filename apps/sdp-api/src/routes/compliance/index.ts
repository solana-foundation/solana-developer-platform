import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import type { Env } from "@/types/env";
import { screenAddress } from "./handlers";

const compliance = new Hono<{ Bindings: Env }>();

compliance.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
compliance.use("*", projectContextMiddleware());

// Uses payments read permission so existing dashboard roles can call this endpoint.
compliance.post("/address-screenings", requirePermissions("payments:read"), screenAddress);

export default compliance;

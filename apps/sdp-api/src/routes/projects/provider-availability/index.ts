import { Hono } from "hono";
import { requirePermissions } from "@/middleware/auth";
import type { Env } from "@/types/env";
import { getProjectProviderAvailabilityHandler } from "./handlers";

// Mounted under /projects/:projectId/provider-availability. Authentication and
// the API-key project binding are applied by the parent projects router.
const projectProviderAvailability = new Hono<{ Bindings: Env }>();

projectProviderAvailability.get(
  "/",
  requirePermissions("projects:read"),
  getProjectProviderAvailabilityHandler
);

export default projectProviderAvailability;

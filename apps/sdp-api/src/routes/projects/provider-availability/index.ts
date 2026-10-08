import { Hono } from "hono";
import type { Env } from "@/types/env";
import { getProjectProviderAvailabilityHandler } from "./handlers";

// Mounted under /projects/:projectId/provider-availability. Authentication and
// the API-key project binding are applied by the parent projects router; any
// caller bound to the project reads it, so no permission is required.
const projectProviderAvailability = new Hono<{ Bindings: Env }>();

projectProviderAvailability.get("/", getProjectProviderAvailabilityHandler);

export default projectProviderAvailability;

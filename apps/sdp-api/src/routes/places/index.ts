import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { type MeteredQuotaConfig, meteredQuota } from "@/middleware/metered-quota";
import { validateBody, validateParams, validateQuery } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { autocomplete, getPlace, getStaticMap } from "./handlers";
import {
  placeDetailsQuerySchema,
  placeIdParamsSchema,
  placesAutocompleteSchema,
  staticMapQuerySchema,
} from "./schemas";

// Every route proxies a billed Google Places call; autocomplete fires per
// keystroke, so the actor ceiling stays interactive-typing friendly.
const PLACES_QUOTA: MeteredQuotaConfig = { name: "places", actorMax: 120, orgMax: 600 };

const places = new Hono<{ Bindings: Env }>();

places.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));

// The quota sits after the permission gate: callers the route would reject
// must not be able to charge the org-wide pool and starve authorized users.
places.post(
  "/autocomplete",
  requirePermissions("counterparties:write"),
  validateBody(placesAutocompleteSchema),
  meteredQuota(PLACES_QUOTA),
  autocomplete
);
places.get(
  "/static-map",
  requirePermissions("counterparties:write"),
  validateQuery(staticMapQuerySchema),
  meteredQuota(PLACES_QUOTA),
  getStaticMap
);
places.get(
  "/:placeId",
  requirePermissions("counterparties:write"),
  validateParams(placeIdParamsSchema),
  validateQuery(placeDetailsQuerySchema),
  meteredQuota(PLACES_QUOTA),
  getPlace
);

export default places;

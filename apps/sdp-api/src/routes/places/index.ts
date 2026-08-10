import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { meteredQuota } from "@/middleware/metered-quota";
import type { Env } from "@/types/env";
import { autocomplete, getPlace, getStaticMap } from "./handlers";

const places = new Hono<{ Bindings: Env }>();

places.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
// Every route proxies a billed Google Places call; autocomplete fires per
// keystroke, so the actor ceiling stays interactive-typing friendly.
places.use("*", meteredQuota({ name: "places", actorMax: 120, orgMax: 600 }));

places.post("/autocomplete", requirePermissions("counterparties:write"), autocomplete);
places.get("/static-map", requirePermissions("counterparties:write"), getStaticMap);
places.get("/:placeId", requirePermissions("counterparties:write"), getPlace);

export default places;

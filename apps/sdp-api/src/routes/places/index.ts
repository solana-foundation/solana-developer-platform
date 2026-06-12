import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import type { Env } from "@/types/env";
import { autocomplete, getPlace, getStaticMap } from "./handlers";

const places = new Hono<{ Bindings: Env }>();

places.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));

places.post("/autocomplete", requirePermissions("counterparties:write"), autocomplete);
places.get("/static-map", requirePermissions("counterparties:write"), getStaticMap);
places.get("/:placeId", requirePermissions("counterparties:write"), getPlace);

export default places;

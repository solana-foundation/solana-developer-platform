/**
 * Allowlist Management Routes (Internal Admin)
 */

import { Hono } from "hono";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import { publicRoute } from "@/middleware/require-action";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { addEntry, listEntries, removeEntry } from "./handlers";
import { adminAuth } from "./middleware";
import { addEntrySchema } from "./schemas";

export const allowlist = new Hono<{ Bindings: Env }>();

allowlist.use("*", unifiedAuthMiddleware());
allowlist.use("*", projectContextMiddleware());
allowlist.use("*", adminAuth);

allowlist.get(
  "/",
  publicRoute("operator: ALLOWLIST_ADMIN_KEY or a platform administrator, not a tenant grant"),
  listEntries
);
allowlist.post(
  "/",
  publicRoute("operator: ALLOWLIST_ADMIN_KEY or a platform administrator, not a tenant grant"),
  validateBody(addEntrySchema),
  addEntry
);
allowlist.delete(
  "/:id",
  publicRoute("operator: ALLOWLIST_ADMIN_KEY or a platform administrator, not a tenant grant"),
  removeEntry
);
